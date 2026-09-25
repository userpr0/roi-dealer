import postgres from 'postgres';
import { correlationIdSchema, idempotencyKeySchema } from '@roi-dealer/events';
import type { HealthCheck, Logger } from '@roi-dealer/observability';
import { InvalidWriteError, translated } from './errors.js';
import { createEventStore, type EventStore } from './event-store.js';
import { atomic, type Sql, type TransactionSql } from './executor.js';
import { createRepositories, type Repositories } from './repositories.js';
import type { WriteContext } from './repository.js';

export interface DatabaseOptions {
  /** `postgres://` URL with credentials. Never logged. */
  readonly url: string;
  /** Shown in `pg_stat_activity`, e.g. `roi-dealer-api`. */
  readonly applicationName: string;
  /** Default: 5. */
  readonly maxConnections?: number;
  /** Default: 10. */
  readonly connectTimeoutSeconds?: number;
  readonly logger?: Logger;
}

export interface TransactionScope {
  readonly sql: TransactionSql;
  readonly repositories: Repositories;
  readonly events: EventStore;
}

export interface TransactionOptions {
  /** Recorded on every event of the transaction; format of `x-correlation-id`. */
  readonly correlationId?: string | undefined;
}

export interface CommandOptions extends TransactionOptions {
  /** What the command does, e.g. `approval.resolve`; stored with the key. */
  readonly name: string;
  /** The same key never runs twice, e.g. `tg-callback-<id>`. */
  readonly idempotencyKey: string;
}

export interface CommandResult<T> {
  /** `duplicate`: the key had already run; `result` is the stored result of that run. */
  readonly outcome: 'executed' | 'duplicate';
  readonly result: T;
}

export interface Database {
  /** The pool, for queries outside the repositories (migrations, health). */
  readonly sql: Sql;
  /** Repositories on the pool: every write is its own transaction with its event. */
  readonly repositories: Repositories;
  /** Event History (read only; events are written by the repositories). */
  readonly events: EventStore;
  /** Runs `work` in one transaction; it commits when `work` resolves and rolls back when it throws. */
  transaction<T>(
    work: (scope: TransactionScope) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  /**
   * Runs `work` in a transaction at most once per idempotency key, also when duplicates arrive
   * at the same time. A failed run stores nothing, so the key can be retried.
   * The result must be JSON-serializable: a duplicate receives it as stored.
   */
  command<T>(
    options: CommandOptions,
    work: (scope: TransactionScope) => Promise<T>,
  ): Promise<CommandResult<T>>;
  ping(): Promise<void>;
  /** Waits up to 5 s for running queries, then closes every connection. */
  close(): Promise<void>;
}

const IDLE_TIMEOUT_SECONDS = 60;
const CLOSE_TIMEOUT_SECONDS = 5;
const COMMAND_NAME = /^[a-z][a-z0-9_.]{0,99}$/;

function writeContext(options: TransactionOptions): WriteContext {
  const { correlationId } = options;
  if (correlationId !== undefined && !correlationIdSchema.safeParse(correlationId).success) {
    throw new InvalidWriteError('invalid_correlation_id', 'Correlation id has an invalid format');
  }
  return { correlationId };
}

function scopeOf(tx: TransactionSql, context: WriteContext): TransactionScope {
  return { sql: tx, repositories: createRepositories(tx, context), events: createEventStore(tx) };
}

/**
 * Opens a connection pool. Sessions run in UTC so every `timestamptz` is read and
 * written without a local offset. Connections are established lazily on the first query.
 */
export function createDatabase(options: DatabaseOptions): Database {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 5,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connection: { application_name: options.applicationName, TimeZone: 'UTC' },
    // The driver prints notices to the console by default; route them to the logger instead.
    onnotice: (notice) => {
      options.logger?.debug('postgres notice', { code: notice['code'] });
    },
  });

  return {
    sql,
    repositories: createRepositories(sql),
    events: createEventStore(sql),

    async transaction(work, transactionOptions = {}) {
      const context = writeContext(transactionOptions);
      return translated(() => atomic(sql, (tx) => work(scopeOf(tx, context))));
    },

    async command(commandOptions, work) {
      const context = writeContext(commandOptions);
      const { name, idempotencyKey } = commandOptions;
      if (!idempotencyKeySchema.safeParse(idempotencyKey).success || !COMMAND_NAME.test(name)) {
        throw new InvalidWriteError(
          'invalid_idempotency_key',
          'Idempotency key or command name has an invalid format',
        );
      }
      return translated(() =>
        atomic(sql, async (tx) => {
          // A concurrent run with the same key waits here until the first one commits or rolls back.
          const claimed = await tx`
            insert into idempotency_keys (key, command, correlation_id)
            values (${idempotencyKey}, ${name}, ${context.correlationId ?? null})
            on conflict (key) do nothing
            returning key
          `;
          if (claimed.length === 0) {
            const [stored] = await tx<{ command: string; result: unknown }[]>`
              select command, result from idempotency_keys where key = ${idempotencyKey}
            `;
            if (stored?.command !== name) {
              throw new InvalidWriteError(
                'idempotency_key_reused',
                'The idempotency key was already used by another command',
              );
            }
            return { outcome: 'duplicate' as const, result: stored.result as never };
          }
          const result = await work(scopeOf(tx, context));
          await tx`
            update idempotency_keys set result = ${tx.json(result ?? null)}
            where key = ${idempotencyKey}
          `;
          return { outcome: 'executed' as const, result };
        }),
      );
    },

    async ping() {
      await sql`select 1`;
    },
    close: () => sql.end({ timeout: CLOSE_TIMEOUT_SECONDS }),
  };
}

/** `GET /health` probe: the database answers a trivial query in time. */
export function createDatabaseHealthCheck(database: Pick<Database, 'ping'>): HealthCheck {
  return {
    name: 'database',
    critical: true,
    async check() {
      await database.ping();
      return { status: 'ok' };
    },
  };
}
