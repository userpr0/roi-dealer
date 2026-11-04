import type { PortfolioCommitted, PortfolioLimits } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor } from './executor.js';

/*
 * The portfolio of tests (phase 26, ADR-0013, migration 0023): the owner's month budget and
 * limits, and the money the month's tests already took.
 */

export interface PortfolioBudgetEntry extends PortfolioLimits {
  /** 'YYYY-MM', UTC. */
  readonly month: string;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface StoredPortfolioBudget extends PortfolioLimits {
  /** The month the budget was set for; it applies until a later one. */
  readonly month: string;
}

export interface PortfolioQueries {
  setBudget(entry: PortfolioBudgetEntry): Promise<void>;
  /** The budget that applies in `month`: the latest one set for it or an earlier month. */
  budget(month: string): Promise<StoredPortfolioBudget | undefined>;
  /**
   * Money taken in the period `[from, to)`: the total budget of tests started in it, and of
   * launches requested or approved but not started, per country and per opportunity.
   */
  committed(period: { readonly from: string; readonly to: string }): Promise<PortfolioCommitted>;
}

export function createPortfolioQueries(executor: Executor): PortfolioQueries {
  return {
    setBudget: (entry) =>
      translated(async () => {
        await executor`
          insert into portfolio_budgets (
            month, total_cents, country_cents, opportunity_cents, actor_id, correlation_id
          ) values (
            ${entry.month}, ${entry.totalCents}, ${entry.countryCents}, ${entry.opportunityCents},
            ${entry.actorId}, ${entry.correlationId ?? null}
          )
        `;
      }),

    budget: (month) =>
      translated(async () => {
        const [row] = await executor<
          {
            month: string;
            total_cents: number;
            country_cents: number;
            opportunity_cents: number;
          }[]
        >`
          select month, total_cents, country_cents, opportunity_cents from portfolio_budgets
          where month <= ${month}
          order by month desc, id desc
          limit 1
        `;
        return row === undefined
          ? undefined
          : {
              month: row.month,
              totalCents: Number(row.total_cents),
              countryCents: Number(row.country_cents),
              opportunityCents: Number(row.opportunity_cents),
            };
      }),

    committed: (period) =>
      translated(async () => {
        const rows = await executor<{ geo: string; opportunity_id: string; cents: string }[]>`
          select h.geo, e.opportunity_id::text as opportunity_id,
                 sum(e.test_budget_usd_cents + e.build_max_money_usd_cents
                     + e.build_max_ai_cost_usd_cents)::text as cents
          from experiments e
          join hypotheses h on h.id = e.hypothesis_id
          where e.status in ('awaiting_approval', 'approved')
             or (e.started_at >= ${period.from} and e.started_at < ${period.to})
          group by h.geo, e.opportunity_id
        `;
        const byCountry: Record<string, number> = {};
        const byOpportunity: Record<string, number> = {};
        let totalCents = 0;
        for (const row of rows) {
          const cents = Number(row.cents);
          totalCents += cents;
          byCountry[row.geo] = (byCountry[row.geo] ?? 0) + cents;
          byOpportunity[row.opportunity_id] = (byOpportunity[row.opportunity_id] ?? 0) + cents;
        }
        return { totalCents, byCountry, byOpportunity };
      }),
  };
}
