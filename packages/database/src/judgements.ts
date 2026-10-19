import type {
  ActorType,
  EvidenceId,
  JudgeCriterion,
  Opportunity,
  OpportunityId,
  Timestamp,
} from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { readRows } from './repository.js';
import { instant, withoutNulls } from './rows.js';
import { opportunitiesTable } from './tables.js';

export const JUDGEMENT_OUTCOMES = ['judged', 'rejected', 'failed'] as const;
export type JudgementOutcome = (typeof JUDGEMENT_OUTCOMES)[number];

/** One judge's assessment of one opportunity version (PHASE 11). */
export interface JudgementEntry {
  readonly opportunityId: OpportunityId;
  readonly opportunityVersion: number;
  readonly criterion: JudgeCriterion;
  readonly taskVersion: number;
  readonly outcome: JudgementOutcome;
  /** 1–5, present exactly for `judged`. */
  readonly score?: number | undefined;
  readonly supported?: boolean | undefined;
  readonly rationale?: string | undefined;
  readonly concerns?: readonly string[] | undefined;
  readonly evidenceIds?: readonly EvidenceId[] | undefined;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface StoredJudgement extends JudgementEntry {
  readonly id: number;
  readonly occurredAt: Timestamp;
  readonly concerns: readonly string[];
  readonly evidenceIds: readonly EvidenceId[];
}

export interface JudgementLog {
  /** Throws `ConstraintViolationError` (`opportunity_judgements_once`) for a repeat. */
  record(entry: JudgementEntry): Promise<void>;
  /**
   * Draft opportunities whose current version is missing some of the six judgements and whose
   * market context is ready: the market agent worked on this version, or the version is older
   * than `waitMs`. Least recently changed first; default 2, at most 100.
   */
  pending(options: {
    readonly marketAgent: string;
    readonly waitMs: number;
    readonly limit?: number | undefined;
  }): Promise<Opportunity[]>;
  /**
   * The judgements of each opportunity at its latest judged version (submitting it for review
   * makes a new version, which the judges do not judge again).
   */
  latest(ids: readonly OpportunityId[]): Promise<ReadonlyMap<OpportunityId, StoredJudgement[]>>;
}

const CRITERIA_COUNT = 6;
const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 100;

function readJudgement(row: Row): StoredJudgement {
  return withoutNulls({
    id: Number(row['id']),
    occurredAt: instant(row['occurred_at']),
    opportunityId: row['opportunity_id'],
    opportunityVersion: Number(row['opportunity_version']),
    criterion: row['criterion'],
    taskVersion: Number(row['task_version']),
    outcome: row['outcome'],
    score: row['score'] === null ? null : Number(row['score']),
    supported: row['supported'],
    rationale: row['rationale'],
    concerns: row['concerns'],
    evidenceIds: row['evidence_ids'],
    actorType: row['actor_type'],
    actorId: row['actor_id'],
    correlationId: row['correlation_id'],
  }) as unknown as StoredJudgement;
}

export function createJudgementLog(executor: Executor): JudgementLog {
  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into opportunity_judgements (
            opportunity_id, opportunity_version, criterion, task_version, outcome, score,
            supported, rationale, concerns, evidence_ids, actor_type, actor_id, correlation_id
          ) values (
            ${entry.opportunityId}, ${entry.opportunityVersion}, ${entry.criterion},
            ${entry.taskVersion}, ${entry.outcome}, ${entry.score ?? null},
            ${entry.supported ?? null}, ${entry.rationale ?? null},
            ${[...(entry.concerns ?? [])]}::text[], ${[...(entry.evidenceIds ?? [])]}::uuid[],
            ${entry.actorType}, ${entry.actorId}, ${entry.correlationId ?? null}
          )
        `;
      }),

    pending: (options) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const seconds = Math.max(Math.trunc(options.waitMs / 1_000), 0);
        const rows = await executor<Row[]>`
          select o.* from opportunities o
          where o.status = 'draft'
            and (
              select count(*) from opportunity_judgements j
              where j.opportunity_id = o.id and j.opportunity_version = o.version
            ) < ${CRITERIA_COUNT}
            and (
              exists (
                select 1 from agent_work w
                where w.agent = ${options.marketAgent} and w.subject_type = 'opportunity'
                  and w.subject_id = o.id and w.subject_version = o.version
              )
              or o.updated_at < now() - make_interval(secs => ${seconds})
            )
          order by o.updated_at, o.id
          limit ${limit}
        `;
        return readRows(executor, opportunitiesTable, rows);
      }),

    latest: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const rows = await executor<Row[]>`
          select j.* from opportunity_judgements j
          where j.opportunity_id = any(${[...ids]}::uuid[])
            and j.opportunity_version = (
              select max(k.opportunity_version) from opportunity_judgements k
              where k.opportunity_id = j.opportunity_id
            )
          order by j.id
        `;
        const result = new Map<OpportunityId, StoredJudgement[]>();
        for (const row of rows) {
          const judgement = readJudgement(row);
          const list = result.get(judgement.opportunityId) ?? [];
          list.push(judgement);
          result.set(judgement.opportunityId, list);
        }
        return result;
      }),
  };
}
