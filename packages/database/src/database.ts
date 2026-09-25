import postgres from 'postgres';
import type { HealthCheck, Logger } from '@roi-dealer/observability';
import { atomic, type Sql, type TransactionSql } from './executor.js';
import { createRepositories, type Repositories } from './repositories.js';

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
}

export interface Database {
  /** The pool, for queries outside the repositories (migrations, health). */
  readonly sql: Sql;
  /** Repositories on the pool: every write is its own transaction. */
  readonly repositories: Repositories;
  /** Runs `work` in one transaction; it commits when `work` resolves and rolls back when it throws. */
  transaction<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  /** Waits up to 5 s for running queries, then closes every connection. */
  close(): Promise<void>;
}

const IDLE_TIMEOUT_SECONDS = 60;
const CLOSE_TIMEOUT_SECONDS = 5;

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
    transaction: (work) =>
      atomic(sql, (tx) => work({ sql: tx, repositories: createRepositories(tx) })),
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
