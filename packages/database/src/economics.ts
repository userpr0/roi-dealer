import {
  COST_CATEGORIES,
  usd,
  type CostCategory,
  type ExperimentId,
  type Money,
  type MoneyFlow,
  type RevenueSummary,
  type Timestamp,
} from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';

/*
 * Economics (PHASE 16): fixed, parameterized sums over the ledgers — costs by category, revenue,
 * the money of each experiment and the automated spend per day — for the panel and the spend
 * guard. Reversals subtract; nothing is estimated (§7.3).
 */

export interface MoneyPeriod {
  /** Inclusive. */
  readonly from: Timestamp;
  /** Exclusive. */
  readonly to: Timestamp;
}

export interface EconomicsQueries {
  /** Costs incurred in the period by category, reversals subtracted; absent categories had none. */
  costsByCategory(period: MoneyPeriod): Promise<ReadonlyMap<CostCategory, Money>>;
  /** Revenue received in the period: payments, preorders, customers. */
  revenue(period: MoneyPeriod): Promise<RevenueSummary>;
  /** Spend (refunds excluded), refunds, revenue and customers of each experiment. */
  moneyFlows(ids: readonly ExperimentId[]): Promise<ReadonlyMap<ExperimentId, MoneyFlow>>;
  /** Costs allocated to experiments in the period, refunds excluded. */
  experimentSpend(period: MoneyPeriod): Promise<Money>;
  /** Hypotheses that got a verdict (confirmed, refuted, inconclusive) in the period. */
  testedHypotheses(period: MoneyPeriod): Promise<number>;
  /**
   * Automated spend per UTC day, micro-USD, oldest first, ending with the day of `until`: AI
   * calls plus costs recorded by the system or integrations (category `ai` excluded — those
   * repeat the AI calls; refunds a payment provider reports are money returned, not spend).
   */
  automatedSpendByDay(options: {
    readonly days: number;
    readonly until: number;
  }): Promise<number[]>;
}

const DAY_MS = 86_400_000;
const MICRO_PER_CENT = 10_000;

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function createEconomicsQueries(executor: Executor): EconomicsQueries {
  return {
    costsByCategory: (period) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select category,
            sum(case when reversal_of is null then amount_usd_cents else -amount_usd_cents end)::bigint
              as total
          from cost_entries
          where incurred_at >= ${period.from} and incurred_at < ${period.to}
          group by category
        `;
        const result = new Map<CostCategory, Money>();
        for (const row of rows) {
          const category = row['category'] as CostCategory;
          if ((COST_CATEGORIES as readonly string[]).includes(category)) {
            result.set(category, usd(Number(row['total'])));
          }
        }
        return result;
      }),

    revenue: (period) =>
      translated(async () => {
        const [row] = await executor<Row[]>`
          select
            coalesce(sum(case when kind = 'payment' then sign * amount_usd_cents end), 0)::bigint
              as payments,
            coalesce(sum(case when kind = 'preorder' then sign * amount_usd_cents end), 0)::bigint
              as preorders,
            coalesce(sum(sign * customers), 0)::bigint as customers
          from (
            select kind, amount_usd_cents, customers,
              case when reversal_of is null then 1 else -1 end as sign
            from revenue_entries
            where received_at >= ${period.from} and received_at < ${period.to}
          ) entries
        `;
        return {
          payments: usd(Number(row?.['payments'] ?? 0)),
          preorders: usd(Number(row?.['preorders'] ?? 0)),
          customers: Number(row?.['customers'] ?? 0),
        };
      }),

    moneyFlows: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const costs = await executor<Row[]>`
          select experiment_id,
            coalesce(sum(case when category <> 'refund' then sign * amount_usd_cents end), 0)::bigint
              as spend,
            coalesce(sum(case when category = 'refund' then sign * amount_usd_cents end), 0)::bigint
              as refunds
          from (
            select experiment_id, category, amount_usd_cents,
              case when reversal_of is null then 1 else -1 end as sign
            from cost_entries where experiment_id = any(${[...ids]}::uuid[])
          ) entries
          group by experiment_id
        `;
        const revenue = await executor<Row[]>`
          select experiment_id,
            coalesce(sum(case when kind = 'payment' then sign * amount_usd_cents end), 0)::bigint
              as payments,
            coalesce(sum(case when kind = 'preorder' then sign * amount_usd_cents end), 0)::bigint
              as preorders,
            coalesce(sum(sign * customers), 0)::bigint as customers
          from (
            select experiment_id, kind, amount_usd_cents, customers,
              case when reversal_of is null then 1 else -1 end as sign
            from revenue_entries where experiment_id = any(${[...ids]}::uuid[])
          ) entries
          group by experiment_id
        `;
        const result = new Map<ExperimentId, MoneyFlow>();
        for (const id of ids) {
          const cost = costs.find((row) => row['experiment_id'] === id);
          const income = revenue.find((row) => row['experiment_id'] === id);
          result.set(id, {
            spend: usd(Number(cost?.['spend'] ?? 0)),
            refunds: usd(Number(cost?.['refunds'] ?? 0)),
            payments: usd(Number(income?.['payments'] ?? 0)),
            preorders: usd(Number(income?.['preorders'] ?? 0)),
            customers: Number(income?.['customers'] ?? 0),
          });
        }
        return result;
      }),

    experimentSpend: (period) =>
      translated(async () => {
        const [row] = await executor<Row[]>`
          select coalesce(sum(
            case when reversal_of is null then amount_usd_cents else -amount_usd_cents end
          ), 0)::bigint as total
          from cost_entries
          where experiment_id is not null and category <> 'refund'
            and incurred_at >= ${period.from} and incurred_at < ${period.to}
        `;
        return usd(Number(row?.['total'] ?? 0));
      }),

    testedHypotheses: (period) =>
      translated(async () => {
        const [row] = await executor<Row[]>`
          select count(*)::bigint as total from hypotheses
          where status in ('confirmed', 'refuted', 'inconclusive')
            and updated_at >= ${period.from} and updated_at < ${period.to}
        `;
        return Number(row?.['total'] ?? 0);
      }),

    automatedSpendByDay: ({ days, until }) =>
      translated(async () => {
        const count = Math.min(Math.max(Math.trunc(days), 1), 60);
        const end = startOfUtcDay(until) + DAY_MS;
        const start = end - count * DAY_MS;
        const from = new Date(start).toISOString();
        const to = new Date(end).toISOString();
        const ai = await executor<Row[]>`
          select floor(extract(epoch from occurred_at) * 1000 / ${DAY_MS})::bigint as day,
            sum(cost_micro_usd)::bigint as total
          from ai_calls
          where occurred_at >= ${from} and occurred_at < ${to}
          group by 1
        `;
        const costs = await executor<Row[]>`
          select floor(extract(epoch from incurred_at) * 1000 / ${DAY_MS})::bigint as day,
            sum(case when reversal_of is null then amount_usd_cents else -amount_usd_cents end)::bigint
              as total
          from cost_entries
          where incurred_at >= ${from} and incurred_at < ${to}
            and created_by_type in ('system', 'integration') and category not in ('ai', 'refund')
          group by 1
        `;
        const totals = Array.from({ length: count }, () => 0);
        const firstDay = start / DAY_MS;
        const add = (day: unknown, micro: number) => {
          const index = Number(day) - firstDay;
          totals[index] = (totals[index] ?? 0) + micro;
        };
        for (const row of ai) add(row['day'], Number(row['total']));
        for (const row of costs) add(row['day'], Number(row['total']) * MICRO_PER_CENT);
        return totals;
      }),
  };
}
