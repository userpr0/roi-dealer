import type {
  ActorType,
  Experiment,
  MediaAssetId,
  Opportunity,
  Pain,
  Timestamp,
} from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { readRows } from './repository.js';
import { instant, withoutNulls } from './rows.js';
import { experimentsTable, opportunitiesTable, painsTable } from './tables.js';

/*
 * Journals of the agents (PHASE 10, migration 0010): runs for /agents and the object versions
 * each agent worked on. Only appended to; texts are never stored.
 */

export const AGENT_RUN_OUTCOMES = ['done', 'idle', 'no_access', 'stopped', 'failed'] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];
export const AGENT_STOPS = ['budget', 'unavailable', 'failed'] as const;
export type AgentStop = (typeof AGENT_STOPS)[number];

export interface AgentRunEntry {
  /** The agent's key, the id of its actor: `pain-analyst`, `researcher`… */
  readonly agent: string;
  readonly startedAt: Timestamp;
  readonly finishedAt: Timestamp;
  readonly outcome: AgentRunOutcome;
  readonly processed: number;
  /** Present exactly for `stopped`. */
  readonly stoppedBy?: AgentStop | undefined;
  /** A short code, present exactly for `failed`. */
  readonly failure?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface StoredAgentRun extends AgentRunEntry {
  readonly id: number;
}

export interface AgentRunTotals {
  readonly runs: number;
  readonly processed: number;
  readonly failed: number;
}

export interface AgentRunLog {
  record(entry: AgentRunEntry): Promise<void>;
  /** The latest run of each agent that ever ran. */
  latest(): Promise<ReadonlyMap<string, StoredAgentRun>>;
  /** Runs, processed objects and failed runs of each agent since `from`. */
  totals(from: Timestamp): Promise<ReadonlyMap<string, AgentRunTotals>>;
}

export const AGENT_WORK_OUTCOMES = ['done', 'empty', 'rejected', 'failed'] as const;
export type AgentWorkOutcome = (typeof AGENT_WORK_OUTCOMES)[number];
export type AgentWorkSubject = 'pain' | 'opportunity' | 'experiment' | 'media_asset';

/** Ids, counts and short checked values only — never a text from evidence or a model. */
export type AgentWorkResult = Readonly<Record<string, string | number | boolean>>;

export interface AgentWorkEntry {
  readonly agent: string;
  readonly subjectType: AgentWorkSubject;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly task: string;
  readonly taskVersion: number;
  readonly outcome: AgentWorkOutcome;
  readonly result?: AgentWorkResult | undefined;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface StoredAgentWork extends AgentWorkEntry {
  readonly id: number;
  readonly occurredAt: Timestamp;
  readonly result: AgentWorkResult;
}

export interface AgentWorkLog {
  /** Throws `ConstraintViolationError` (`agent_work_version_once`) for a repeat. */
  record(entry: AgentWorkEntry): Promise<void>;
  /**
   * Candidate pains with fewer than `maxSignals` signals whose current version the agent has
   * not worked on; most severe and most recently changed first. Default 3, at most 100.
   */
  pendingPains(options: {
    readonly agent: string;
    readonly maxSignals: number;
    readonly limit?: number | undefined;
  }): Promise<Pain[]>;
  /**
   * Opportunities in `status` (default `draft`) whose current version the agent has not worked
   * on; least recently changed first. Default 3, at most 100. (Under review is the owner's turn:
   * PHASE 11–12; `approved` ones get their hypotheses, PHASE 14.)
   */
  pendingOpportunities(options: {
    readonly agent: string;
    readonly status?: 'draft' | 'approved' | undefined;
    readonly limit?: number | undefined;
  }): Promise<Opportunity[]>;
  /**
   * Tests that need a landing (PHASE 19a): artifact `landing`, not started yet, without a live
   * asset; either their current version was not worked on, or a rejected asset waits for a
   * rewrite (`rework`) and the test has at most `maxRewrites` rejected assets. Least recently
   * changed first. Default 3, at most 100.
   */
  pendingLandings(options: {
    readonly agent: string;
    readonly maxRewrites: number;
    readonly limit?: number | undefined;
  }): Promise<{ readonly experiment: Experiment; readonly rework?: MediaAssetId | undefined }[]>;
  /** Newest first; default 50, at most 1 000. */
  list(options?: {
    readonly agent?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<StoredAgentWork[]>;
}

const DEFAULT_PENDING = 3;
const MAX_PENDING = 100;
const DEFAULT_LIST = 50;
const MAX_LIST = 1_000;

const bounded = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback), 1), max);

function readRun(row: Row): StoredAgentRun {
  return withoutNulls({
    id: Number(row['id']),
    agent: row['agent'],
    startedAt: instant(row['started_at']),
    finishedAt: instant(row['finished_at']),
    outcome: row['outcome'],
    processed: Number(row['processed']),
    stoppedBy: row['stopped_by'],
    failure: row['failure'],
    correlationId: row['correlation_id'],
  }) as unknown as StoredAgentRun;
}

function readWork(row: Row): StoredAgentWork {
  return withoutNulls({
    id: Number(row['id']),
    occurredAt: instant(row['occurred_at']),
    agent: row['agent'],
    subjectType: row['subject_type'],
    subjectId: String(row['subject_id']),
    subjectVersion: Number(row['subject_version']),
    task: row['task'],
    taskVersion: Number(row['task_version']),
    outcome: row['outcome'],
    result: row['result'],
    actorType: row['actor_type'],
    actorId: row['actor_id'],
    correlationId: row['correlation_id'],
  }) as unknown as StoredAgentWork;
}

export function createAgentRunLog(executor: Executor): AgentRunLog {
  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into agent_runs (
            agent, started_at, finished_at, outcome, processed, stopped_by, failure,
            correlation_id
          ) values (
            ${entry.agent}, ${entry.startedAt}, ${entry.finishedAt}, ${entry.outcome},
            ${entry.processed}, ${entry.stoppedBy ?? null}, ${entry.failure ?? null},
            ${entry.correlationId ?? null}
          )
        `;
      }),

    latest: () =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select distinct on (agent) * from agent_runs
          order by agent, started_at desc, id desc
        `;
        return new Map(rows.map((row) => [String(row['agent']), readRun(row)]));
      }),

    totals: (from) =>
      translated(async () => {
        const rows = await executor<
          { agent: string; runs: string; processed: string; failed: string }[]
        >`
          select agent, count(*) as runs, coalesce(sum(processed), 0) as processed,
                 count(*) filter (where outcome = 'failed') as failed
          from agent_runs where started_at >= ${from}
          group by agent
        `;
        return new Map(
          rows.map((row) => [
            row.agent,
            {
              runs: Number(row.runs),
              processed: Number(row.processed),
              failed: Number(row.failed),
            },
          ]),
        );
      }),
  };
}

export function createAgentWorkLog(executor: Executor): AgentWorkLog {
  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into agent_work (
            agent, subject_type, subject_id, subject_version, task, task_version, outcome,
            result, actor_type, actor_id, correlation_id
          ) values (
            ${entry.agent}, ${entry.subjectType}, ${entry.subjectId}, ${entry.subjectVersion},
            ${entry.task}, ${entry.taskVersion}, ${entry.outcome},
            ${executor.json({ ...(entry.result ?? {}) })}, ${entry.actorType}, ${entry.actorId},
            ${entry.correlationId ?? null}
          )
        `;
      }),

    pendingPains: (options) =>
      translated(async () => {
        const limit = bounded(options.limit, DEFAULT_PENDING, MAX_PENDING);
        const rows = await executor<Row[]>`
          select p.* from pains p
          where p.status = 'candidate'
            and (select count(*) from pain_signals s where s.pain_id = p.id) < ${options.maxSignals}
            and not exists (
              select 1 from agent_work w
              where w.agent = ${options.agent} and w.subject_type = 'pain'
                and w.subject_id = p.id and w.subject_version = p.version
            )
          order by p.severity desc, p.updated_at desc, p.id
          limit ${limit}
        `;
        return readRows(executor, painsTable, rows);
      }),

    pendingOpportunities: (options) =>
      translated(async () => {
        const limit = bounded(options.limit, DEFAULT_PENDING, MAX_PENDING);
        const rows = await executor<Row[]>`
          select o.* from opportunities o
          where o.status = ${options.status ?? 'draft'}
            and not exists (
              select 1 from agent_work w
              where w.agent = ${options.agent} and w.subject_type = 'opportunity'
                and w.subject_id = o.id and w.subject_version = o.version
            )
          order by o.updated_at, o.id
          limit ${limit}
        `;
        return readRows(executor, opportunitiesTable, rows);
      }),

    pendingLandings: (options) =>
      translated(async () => {
        const limit = bounded(options.limit, DEFAULT_PENDING, MAX_PENDING);
        const reworkable = executor`
          select m.id from media_assets m
          where m.experiment_id = e.id and m.status = 'rejected'
            and not exists (
              select 1 from agent_work w
              where w.agent = ${options.agent} and w.subject_type = 'media_asset'
                and w.subject_id = m.id and w.subject_version = m.version
            )
          order by m.updated_at desc, m.id desc
          limit 1
        `;
        const rows = await executor<Row[]>`
          select e.*, (${reworkable}) as rework_id from experiments e
          where e.artifact = 'landing'
            and e.status in ('planned', 'awaiting_approval', 'approved')
            and not exists (
              select 1 from media_assets m
              where m.experiment_id = e.id and m.status in ('draft', 'approved', 'released')
            )
            and (
              select count(*) from media_assets m
              where m.experiment_id = e.id and m.status = 'rejected'
            ) <= ${options.maxRewrites}
            and (
              not exists (
                select 1 from agent_work w
                where w.agent = ${options.agent} and w.subject_type = 'experiment'
                  and w.subject_id = e.id and w.subject_version = e.version
              )
              or exists (${reworkable})
            )
          order by e.updated_at, e.id
          limit ${limit}
        `;
        const experiments = await readRows(executor, experimentsTable, rows);
        return experiments.map((experiment) => {
          const rework = rows.find((row) => row['id'] === experiment.id)?.['rework_id'];
          return typeof rework === 'string'
            ? { experiment, rework: rework as MediaAssetId }
            : { experiment };
        });
      }),

    list: (options = {}) =>
      translated(async () => {
        const limit = bounded(options.limit, DEFAULT_LIST, MAX_LIST);
        const rows = await executor<Row[]>`
          select * from agent_work where true
            ${options.agent === undefined ? executor`` : executor`and agent = ${options.agent}`}
            ${options.subjectId === undefined ? executor`` : executor`and subject_id = ${options.subjectId}`}
          order by id desc
          limit ${limit}
        `;
        return rows.map(readWork);
      }),
  };
}
