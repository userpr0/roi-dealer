import { usd, type Money, type Timestamp } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';

/*
 * Statistics of the cycle (PHASE 13, D-014 п.11): fixed counts over the tables — from evidence
 * to revenue — and the system's own metrics. Read-only, parameterized, computed in SQL (§7.3).
 */

export interface CycleCounts {
  readonly evidence: number;
  readonly signals: number;
  readonly pains: number;
  readonly painsValidated: number;
  readonly opportunities: number;
  readonly opportunitiesUnderReview: number;
  /** Approved by the owner and not closed: approved, validating, scaling, paused. */
  readonly opportunitiesInWork: number;
  readonly hypotheses: number;
  readonly experimentsStarted: number;
  readonly experimentsCompleted: number;
  readonly customers: number;
  /** Payments and preorders, reversals subtracted. */
  readonly revenue: Money;
}

export interface StatsQueries {
  /** What the cycle produced since `from` (created in the period); all time without `from`. */
  cycle(from?: Timestamp): Promise<CycleCounts>;
  /**
   * Median days from the first signal of an opportunity's pains to the owner's decision on it,
   * over the owner's opportunity decisions in the period; absent without decisions.
   */
  decisionLatencyDays(period: {
    readonly from: Timestamp;
    readonly to: Timestamp;
  }): Promise<number | undefined>;
  /** Knowledge assets created in the period, eval reports and market context excluded. */
  newKnowledge(period: { readonly from: Timestamp; readonly to: Timestamp }): Promise<number>;
  /** The owner's decisions in the period by subject and outcome. */
  decisionsByOutcome(period: {
    readonly from: Timestamp;
    readonly to: Timestamp;
  }): Promise<
    readonly { readonly subject: string; readonly outcome: string; readonly count: number }[]
  >;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

export function createStatsQueries(executor: Executor): StatsQueries {
  return {
    cycle: (from) =>
      translated(async () => {
        const since = from ?? EPOCH;
        const [row] = await executor<Row[]>`
          select
            (select count(*) from evidence where created_at >= ${since})::bigint as evidence,
            (select count(*) from signals where created_at >= ${since})::bigint as signals,
            (select count(*) from pains where created_at >= ${since})::bigint as pains,
            (select count(*) from pains where created_at >= ${since}
              and status = 'validated')::bigint as pains_validated,
            (select count(*) from opportunities where created_at >= ${since})::bigint
              as opportunities,
            (select count(*) from opportunities where created_at >= ${since}
              and status = 'under_review')::bigint as opportunities_under_review,
            (select count(*) from opportunities where created_at >= ${since}
              and status in ('approved', 'validating', 'scaling', 'paused'))::bigint
              as opportunities_in_work,
            (select count(*) from hypotheses where created_at >= ${since})::bigint as hypotheses,
            (select count(*) from experiments where started_at >= ${since})::bigint
              as experiments_started,
            (select count(*) from experiments where status = 'completed'
              and ended_at >= ${since})::bigint as experiments_completed,
            (select coalesce(sum(case when reversal_of is null then customers else -customers end), 0)
              from revenue_entries where received_at >= ${since})::bigint as customers,
            (select coalesce(sum(case when reversal_of is null then amount_usd_cents
                else -amount_usd_cents end), 0)
              from revenue_entries where received_at >= ${since})::bigint as revenue
        `;
        const count = (key: string) => Number(row?.[key] ?? 0);
        return {
          evidence: count('evidence'),
          signals: count('signals'),
          pains: count('pains'),
          painsValidated: count('pains_validated'),
          opportunities: count('opportunities'),
          opportunitiesUnderReview: count('opportunities_under_review'),
          opportunitiesInWork: count('opportunities_in_work'),
          hypotheses: count('hypotheses'),
          experimentsStarted: count('experiments_started'),
          experimentsCompleted: count('experiments_completed'),
          customers: count('customers'),
          revenue: usd(count('revenue')),
        };
      }),

    decisionLatencyDays: (period) =>
      translated(async () => {
        const [row] = await executor<Row[]>`
          select percentile_cont(0.5) within group (order by days) as median
          from (
            select extract(epoch from (d.created_at - (
              select min(s.created_at) from opportunity_pains op
              join pain_signals ps on ps.pain_id = op.pain_id
              join signals s on s.id = ps.signal_id
              where op.opportunity_id = d.subject_id
            ))) / 86400 as days
            from decisions d
            where d.subject_type = 'opportunity' and d.created_by_type = 'owner'
              and d.created_at >= ${period.from} and d.created_at < ${period.to}
          ) latencies
          where days is not null
        `;
        const median = row?.['median'];
        return median === null || median === undefined
          ? undefined
          : Math.round(Number(median) * 10) / 10;
      }),

    newKnowledge: (period) =>
      translated(async () => {
        const [row] = await executor<Row[]>`
          select count(*)::bigint as total from knowledge_assets
          where created_at >= ${period.from} and created_at < ${period.to}
            and not (tags && array['eval', 'market-context']::text[])
        `;
        return Number(row?.['total'] ?? 0);
      }),

    decisionsByOutcome: (period) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select subject_type, outcome, count(*)::bigint as total from decisions
          where created_by_type = 'owner'
            and created_at >= ${period.from} and created_at < ${period.to}
          group by subject_type, outcome
          order by subject_type, outcome
        `;
        return rows.map((row) => ({
          subject: String(row['subject_type']),
          outcome: String(row['outcome']),
          count: Number(row['total']),
        }));
      }),
  };
}
