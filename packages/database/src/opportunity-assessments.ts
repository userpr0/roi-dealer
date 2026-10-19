import type { ActorType, OpportunityId, Pain, PainId } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { readRows } from './repository.js';
import { painsTable } from './tables.js';

export const OPPORTUNITY_ASSESSMENT_OUTCOMES = [
  'opportunity',
  'below_threshold',
  'rejected',
  'failed',
] as const;
export type OpportunityAssessmentOutcome = (typeof OPPORTUNITY_ASSESSMENT_OUTCOMES)[number];

/** Parts of the score, in points (PHASE 07). */
export type ScoreComponents = Readonly<Record<string, number>>;

/** How one version of a pain was assessed (PHASE 07). Texts are never stored here. */
export interface OpportunityAssessmentEntry {
  readonly painId: PainId;
  readonly painVersion: number;
  readonly taskVersion: number;
  readonly outcome: OpportunityAssessmentOutcome;
  /** 0–100, present exactly for `opportunity` and `below_threshold`. */
  readonly score?: number | undefined;
  readonly components?: ScoreComponents | undefined;
  /** Present exactly for `opportunity`. */
  readonly opportunityId?: OpportunityId | undefined;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface OpportunityScore {
  readonly score: number;
  readonly components: ScoreComponents;
}

/** The journal of opportunity assessments: only appended to (migration 0008). */
export interface OpportunityAssessmentLog {
  /** Throws `ConstraintViolationError` (`opportunity_assessments_pain_version_once`) for a repeat. */
  record(entry: OpportunityAssessmentEntry): Promise<void>;
  /**
   * Open pains with at least `minSignals` signals whose current version is not assessed yet and
   * that produced no opportunity; least recently changed first. Default 5, at most 100.
   */
  pending(options: {
    readonly minSignals: number;
    readonly limit?: number | undefined;
  }): Promise<Pain[]>;
  /** The score each opportunity was created with. */
  scores(ids: readonly OpportunityId[]): Promise<ReadonlyMap<OpportunityId, OpportunityScore>>;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

export function createOpportunityAssessmentLog(executor: Executor): OpportunityAssessmentLog {
  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into opportunity_assessments (
            pain_id, pain_version, task_version, outcome, score, components, opportunity_id,
            actor_type, actor_id, correlation_id
          ) values (
            ${entry.painId}, ${entry.painVersion}, ${entry.taskVersion}, ${entry.outcome},
            ${entry.score ?? null},
            ${entry.components === undefined ? null : executor.json({ ...entry.components })},
            ${entry.opportunityId ?? null}, ${entry.actorType}, ${entry.actorId},
            ${entry.correlationId ?? null}
          )
        `;
      }),

    pending: (options) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const rows = await executor<Row[]>`
          select p.* from pains p
          where p.status in ('candidate', 'validated')
            and (select count(*) from pain_signals s where s.pain_id = p.id) >= ${options.minSignals}
            and not exists (
              select 1 from opportunity_assessments a
              where a.pain_id = p.id and (a.pain_version = p.version or a.outcome = 'opportunity')
            )
          order by p.updated_at, p.id
          limit ${limit}
        `;
        return readRows(executor, painsTable, rows);
      }),

    scores: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const rows = await executor<
          { opportunity_id: OpportunityId; score: number; components: ScoreComponents }[]
        >`
          select opportunity_id, score, components from opportunity_assessments
          where outcome = 'opportunity' and opportunity_id = any(${[...ids]}::uuid[])
        `;
        return new Map(
          rows.map((row) => [
            row.opportunity_id,
            { score: Number(row.score), components: row.components },
          ]),
        );
      }),
  };
}
