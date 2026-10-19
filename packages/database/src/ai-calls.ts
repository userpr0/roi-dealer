import { timestampSchema, type ActorType, type Timestamp } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { instant, withoutNulls } from './rows.js';

export const AI_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_CALL_PURPOSES = ['task', 'eval'] as const;
export type AiCallPurpose = (typeof AI_CALL_PURPOSES)[number];

/** Why an AI call failed (PHASE 09); the router decides on the next attempt by this class. */
export const AI_FAILURES = [
  'rate_limited',
  'timeout',
  'server_error',
  'invalid_output',
  'refusal',
  'model_unavailable',
  'auth',
  'bad_request',
] as const;
export type AiFailure = (typeof AI_FAILURES)[number];

/** One attempt of an AI task. Prompts, outputs and keys are never stored. */
export interface AiCallEntry {
  /** Default: the database clock. */
  readonly occurredAt?: Timestamp | undefined;
  readonly task: string;
  readonly taskVersion: number;
  readonly purpose: AiCallPurpose;
  readonly provider: AiProvider;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Millionths of a US dollar. */
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly outcome: 'ok' | 'failed';
  /** Present exactly for failed attempts. */
  readonly failure?: AiFailure | undefined;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface StoredAiCall extends AiCallEntry {
  readonly id: number;
  readonly occurredAt: Timestamp;
}

export interface AiCallPeriod {
  /** Inclusive lower bound of `occurredAt`. */
  readonly from?: Timestamp | undefined;
  /** Exclusive upper bound of `occurredAt`. */
  readonly to?: Timestamp | undefined;
  /** Only the calls of this task. */
  readonly task?: string | undefined;
  readonly purpose?: AiCallPurpose | undefined;
  /** Only the calls made for this actor id, e.g. an agent (PHASE 10). */
  readonly actorId?: string | undefined;
}

export interface AiSpend {
  readonly costMicroUsd: number;
  readonly calls: number;
  readonly failed: number;
}

/** The AI call journal: only appended to (migration 0006). */
export interface AiCallLog {
  record(entry: AiCallEntry): Promise<void>;
  /** Total cost and number of calls in the period. */
  spend(period?: AiCallPeriod): Promise<AiSpend>;
  /** Newest first; default 50, at most 1 000. */
  list(period?: AiCallPeriod & { readonly limit?: number | undefined }): Promise<StoredAiCall[]>;
  /** Time of the latest successful call of each provider, if any. */
  lastSuccess(): Promise<Partial<Record<AiProvider, Timestamp>>>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1_000;

function readCall(row: Row): StoredAiCall {
  return withoutNulls({
    id: Number(row['id']),
    occurredAt: instant(row['occurred_at']),
    task: row['task'],
    taskVersion: row['task_version'],
    purpose: row['purpose'],
    provider: row['provider'],
    model: row['model'],
    inputTokens: row['input_tokens'],
    outputTokens: row['output_tokens'],
    costMicroUsd: Number(row['cost_micro_usd']),
    latencyMs: row['latency_ms'],
    outcome: row['outcome'],
    failure: row['failure'],
    actorType: row['actor_type'],
    actorId: row['actor_id'],
    correlationId: row['correlation_id'],
  }) as unknown as StoredAiCall;
}

export function createAiCallLog(executor: Executor): AiCallLog {
  const period = (query: AiCallPeriod) => executor`
    ${query.from === undefined ? executor`` : executor`and occurred_at >= ${query.from}`}
    ${query.to === undefined ? executor`` : executor`and occurred_at < ${query.to}`}
    ${query.task === undefined ? executor`` : executor`and task = ${query.task}`}
    ${query.purpose === undefined ? executor`` : executor`and purpose = ${query.purpose}`}
    ${query.actorId === undefined ? executor`` : executor`and actor_id = ${query.actorId}`}
  `;

  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into ai_calls (
            occurred_at, task, task_version, purpose, provider, model, input_tokens,
            output_tokens, cost_micro_usd, latency_ms, outcome, failure, actor_type, actor_id,
            correlation_id
          ) values (
            coalesce(${entry.occurredAt ?? null}::timestamptz, now()), ${entry.task},
            ${entry.taskVersion}, ${entry.purpose}, ${entry.provider}, ${entry.model},
            ${entry.inputTokens}, ${entry.outputTokens}, ${entry.costMicroUsd},
            ${entry.latencyMs}, ${entry.outcome}, ${entry.failure ?? null}, ${entry.actorType},
            ${entry.actorId}, ${entry.correlationId ?? null}
          )
        `;
      }),

    spend: (query = {}) =>
      translated(async () => {
        const [row] = await executor<{ cost: string; calls: string; failed: string }[]>`
          select coalesce(sum(cost_micro_usd), 0) as cost, count(*) as calls,
                 count(*) filter (where outcome = 'failed') as failed
          from ai_calls where true ${period(query)}
        `;
        return {
          costMicroUsd: Number(row?.cost ?? 0),
          calls: Number(row?.calls ?? 0),
          failed: Number(row?.failed ?? 0),
        };
      }),

    list: (query = {}) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const rows = await executor<Row[]>`
          select * from ai_calls where true ${period(query)}
          order by id desc
          limit ${limit}
        `;
        return rows.map(readCall);
      }),

    lastSuccess: () =>
      translated(async () => {
        const rows = await executor<{ provider: AiProvider; at: unknown }[]>`
          select provider, max(occurred_at) as at from ai_calls
          where outcome = 'ok' group by provider
        `;
        const last: Partial<Record<AiProvider, Timestamp>> = {};
        for (const row of rows) last[row.provider] = timestampSchema.parse(instant(row.at));
        return last;
      }),
  };
}
