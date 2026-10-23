import postgres from 'postgres';
import { correlationIdSchema, idempotencyKeySchema } from '@roi-dealer/events';
import type { HealthCheck, Logger } from '@roi-dealer/observability';
import { createAccessLog, type AccessLog, type AccessLogEntry } from './access-log.js';
import {
  createAgentRunLog,
  createAgentWorkLog,
  type AgentRunLog,
  type AgentWorkLog,
} from './agents.js';
import { createAiCallLog, type AiCallLog } from './ai-calls.js';
import { createBrainQueries, type BrainQueries } from './brain.js';
import { createEconomicsQueries, type EconomicsQueries } from './economics.js';
import { createLeadContacts, type LeadContacts } from './lead-contacts.js';
import { createPaymentEventLog, type PaymentEventLog } from './payments.js';
import { createServiceWatch, type ServiceWatch } from './services.js';
import { createFunnelLog, type FunnelLog } from './experiments.js';
import { createStatsQueries, type StatsQueries } from './stats.js';
import { createJudgementLog, type JudgementLog } from './judgements.js';
import type { AccessDeniedHandler } from './access.js';
import { InvalidWriteError, translated } from './errors.js';
import { createEventStore, type EventStore } from './event-store.js';
import { atomic, type Sql, type TransactionSql } from './executor.js';
import { createRepositories, type Repositories } from './repositories.js';
import type { WriteContext } from './repository.js';
import { createSignalExtractionLog, type SignalExtractionLog } from './signal-extractions.js';
import { createPainReviewQueries, type PainReviewQueries } from './pain-review.js';
import {
  createOpportunityAssessmentLog,
  type OpportunityAssessmentLog,
} from './opportunity-assessments.js';

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
  /** Recorded in the same transaction as the signal and pain it describes (PHASE 06). */
  readonly signalExtractions: SignalExtractionLog;
  /** Recorded in the same transaction as the opportunity it created (PHASE 07). */
  readonly opportunityAssessments: OpportunityAssessmentLog;
  /** Recorded in the same transaction as the result an agent stored (PHASE 10). */
  readonly agentWork: AgentWorkLog;
  /** Recorded in the same transaction as the opportunity it completes (PHASE 11). */
  readonly judgements: JudgementLog;
  /** Recorded in the same transaction as the spend and stop it may cause (PHASE 15). */
  readonly funnel: FunnelLog;
  /** Sums over the ledgers, read in the same transaction as the money they limit (PHASE 16). */
  readonly economics: EconomicsQueries;
  /** Emails of leads, written and deleted with the lead's change (PHASE 20). */
  readonly leadContacts: LeadContacts;
  /** Payment events, recorded with the revenue or refund they create (PHASE 20b). */
  readonly payments: PaymentEventLog;
  /** The watchdog's incidents, opened in the same transaction as the notice to the owner (13c). */
  readonly services: ServiceWatch;
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
  /** Views and refused access attempts (PHASE 04); refused writes are recorded automatically. */
  readonly access: AccessLog;
  /** Journal of AI calls: tokens, cost and failures (PHASE 09). */
  readonly aiCalls: AiCallLog;
  /** Journal of evidence analysis for pains (PHASE 06). */
  readonly signalExtractions: SignalExtractionLog;
  /** Russian titles and source counts of pains for the owner's review (D-030). */
  readonly painReview: PainReviewQueries;
  /** Journal of opportunity assessments (PHASE 07). */
  readonly opportunityAssessments: OpportunityAssessmentLog;
  /** Company Brain: search, counts and totals by fixed parameterized queries (PHASE 08). */
  readonly brain: BrainQueries;
  /** Journal of agent runs (PHASE 10). */
  readonly agentRuns: AgentRunLog;
  /** Journal of the object versions agents worked on (PHASE 10). */
  readonly agentWork: AgentWorkLog;
  /** Journal of the judges' assessments of opportunities (PHASE 11). */
  readonly judgements: JudgementLog;
  /** The funnel of experiments and their spend (PHASE 15). */
  readonly funnel: FunnelLog;
  /** Sums over the cost and revenue ledgers and the automated spend per day (PHASE 16). */
  readonly economics: EconomicsQueries;
  /** Counts of the cycle and the system's metrics (PHASE 13). */
  readonly stats: StatsQueries;
  /** Emails of leads, apart from the history (PHASE 20). */
  readonly leadContacts: LeadContacts;
  /** What the payment provider reported, once per event (PHASE 20b). */
  readonly payments: PaymentEventLog;
  /** Heartbeats of the services and the watchdog's incidents (13c). */
  readonly services: ServiceWatch;
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

function writeContext(
  options: TransactionOptions,
  onAccessDenied: AccessDeniedHandler,
): WriteContext {
  const { correlationId } = options;
  if (correlationId !== undefined && !correlationIdSchema.safeParse(correlationId).success) {
    throw new InvalidWriteError('invalid_correlation_id', 'Correlation id has an invalid format');
  }
  return { correlationId, onAccessDenied };
}

function scopeOf(tx: TransactionSql, context: WriteContext): TransactionScope {
  return {
    sql: tx,
    repositories: createRepositories(tx, context),
    events: createEventStore(tx),
    signalExtractions: createSignalExtractionLog(tx),
    opportunityAssessments: createOpportunityAssessmentLog(tx),
    agentWork: createAgentWorkLog(tx),
    judgements: createJudgementLog(tx),
    funnel: createFunnelLog(tx),
    economics: createEconomicsQueries(tx),
    leadContacts: createLeadContacts(tx),
    payments: createPaymentEventLog(tx),
    services: createServiceWatch(tx),
  };
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

  const access = createAccessLog(sql);
  const recordDenial: AccessDeniedHandler = async (entry) => {
    try {
      await access.record(entry);
    } catch (error) {
      options.logger?.warn('access denial not recorded', { error });
    }
  };

  /**
   * Refusals inside a transaction are recorded after it ends (commit or rollback): recording
   * needs another pooled connection, which must not be awaited while this one is held.
   */
  async function recordingDenials<T>(
    transactionOptions: TransactionOptions,
    run: (context: WriteContext) => Promise<T>,
  ): Promise<T> {
    const denials: AccessLogEntry[] = [];
    const context = writeContext(transactionOptions, (entry) => {
      denials.push(entry);
      return Promise.resolve();
    });
    try {
      return await run(context);
    } finally {
      for (const entry of denials) await recordDenial(entry);
    }
  }

  return {
    sql,
    repositories: createRepositories(sql, { onAccessDenied: recordDenial }),
    events: createEventStore(sql),
    access,
    aiCalls: createAiCallLog(sql),
    signalExtractions: createSignalExtractionLog(sql),
    painReview: createPainReviewQueries(sql),
    opportunityAssessments: createOpportunityAssessmentLog(sql),
    brain: createBrainQueries(sql),
    agentRuns: createAgentRunLog(sql),
    agentWork: createAgentWorkLog(sql),
    judgements: createJudgementLog(sql),
    funnel: createFunnelLog(sql),
    economics: createEconomicsQueries(sql),
    stats: createStatsQueries(sql),
    leadContacts: createLeadContacts(sql),
    payments: createPaymentEventLog(sql),
    services: createServiceWatch(sql),

    transaction: (work, transactionOptions = {}) =>
      recordingDenials(transactionOptions, (context) =>
        translated(() => atomic(sql, (tx) => work(scopeOf(tx, context)))),
      ),

    command: (commandOptions, work) =>
      recordingDenials(commandOptions, (context) => runCommand(commandOptions, context, work)),

    async ping() {
      await sql`select 1`;
    },
    close: () => sql.end({ timeout: CLOSE_TIMEOUT_SECONDS }),
  };

  async function runCommand<T>(
    commandOptions: CommandOptions,
    context: WriteContext,
    work: (scope: TransactionScope) => Promise<T>,
  ): Promise<CommandResult<T>> {
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
  }
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
