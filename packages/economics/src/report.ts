import {
  AI_BUDGET_LIMITS,
  budgetState,
  dailyAiAllowanceMicroUsd,
  experimentTotalBudget,
  MONTHLY_LIMITS,
  startOfUtcDay,
  startOfUtcMonth,
  sumMoney,
  toTimestamp,
  usd,
  ZERO_USD,
  type BudgetState,
  type CostCategory,
  type Money,
  type RevenueSummary,
} from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';

const DAY_MS = 86_400_000;
const MICRO_PER_CENT = 10_000;
const iso = (ms: number) => toTimestamp(new Date(ms));

/** AI spend in cents, rounded up like the daily cost entry (PHASE 09). */
export function aiCents(micro: number): Money {
  return usd(Math.ceil(micro / MICRO_PER_CENT));
}

export interface BudgetLine {
  readonly category: CostCategory;
  readonly spent: Money;
  readonly limit: Money;
  readonly state: BudgetState;
}

export interface EconomicsReport {
  /** `YYYY-MM` of the UTC month. */
  readonly month: string;
  /** Costs of the month by category; AI comes from the call journal (today included). */
  readonly costs: ReadonlyMap<CostCategory, Money>;
  readonly ai: {
    readonly monthMicroUsd: number;
    readonly todayMicroUsd: number;
    readonly allowanceMicroUsd: number;
  };
  /** Categories with a monthly limit (D-007). */
  readonly budgets: readonly BudgetLine[];
  /** Approved, running and stopped tests: their approved budgets and spend (refunds excluded). */
  readonly tests: { readonly active: number; readonly approved: Money; readonly spent: Money };
  readonly revenue: RevenueSummary;
  readonly refunds: Money;
  /** Every cost of the month, refunds excluded (they reduce revenue instead). */
  readonly totalCosts: Money;
  /** D-014 п.11: confirmed revenue (payments − refunds) / all costs, percent; absent without costs. */
  readonly roiPercent?: number | undefined;
  readonly testedHypotheses: number;
  /** D-014 п.11: experiment spend / hypotheses with a verdict; absent without verdicts. */
  readonly costPerTestedHypothesis?: Money | undefined;
}

/**
 * The month so far (UTC) from the ledgers and the AI call journal (§7.3): costs by category
 * against the D-007 limits, tests against their approvals, revenue, ROI and the cost of a
 * tested hypothesis. Nothing is estimated.
 */
export async function monthReport(database: Database, nowMs: number): Promise<EconomicsReport> {
  const monthStart = startOfUtcMonth(nowMs);
  const dayStart = startOfUtcDay(nowMs);
  const period = { from: iso(monthStart), to: iso(nowMs + 1) };
  const { economics, aiCalls, repositories, funnel } = database;

  const [byCategory, revenue, beforeToday, today, testedHypotheses, testSpend] = await Promise.all([
    economics.costsByCategory(period),
    economics.revenue(period),
    aiCalls.spend({ from: iso(monthStart), to: iso(dayStart) }),
    aiCalls.spend({ from: iso(dayStart), to: iso(dayStart + DAY_MS) }),
    economics.testedHypotheses(period),
    economics.experimentSpend(period),
  ]);
  const aiMonth = beforeToday.costMicroUsd + today.costMicroUsd;
  const costs = new Map(byCategory);
  // The daily `ai` entries repeat the call journal, which also has today.
  costs.set('ai', aiCents(aiMonth));
  const refunds = costs.get('refund') ?? ZERO_USD;
  costs.delete('refund');

  const budgets: BudgetLine[] = [];
  for (const [category, limit] of Object.entries(MONTHLY_LIMITS) as [CostCategory, Money][]) {
    const spent = costs.get(category) ?? ZERO_USD;
    budgets.push({ category, spent, limit, state: budgetState(spent, limit) });
  }

  const active = [];
  for (const status of ['approved', 'running', 'stopped'] as const) {
    active.push(...(await repositories.experiments.listByStatus(status, { limit: 1_000 })));
  }
  const spentByTest = await funnel.spent(active.map((item) => item.id));
  const totalCosts = sumMoney([...costs.values()]);
  const confirmed = revenue.payments.amountCents - refunds.amountCents;

  return {
    month: new Date(monthStart).toISOString().slice(0, 7),
    costs,
    ai: {
      monthMicroUsd: aiMonth,
      todayMicroUsd: today.costMicroUsd,
      allowanceMicroUsd: dailyAiAllowanceMicroUsd(
        AI_BUDGET_LIMITS,
        beforeToday.costMicroUsd,
        nowMs,
      ),
    },
    budgets,
    tests: {
      active: active.length,
      approved: sumMoney(active.map(experimentTotalBudget)),
      spent: sumMoney(active.map((item) => spentByTest.get(item.id) ?? ZERO_USD)),
    },
    revenue,
    refunds,
    totalCosts,
    roiPercent:
      totalCosts.amountCents > 0
        ? Math.round((confirmed / totalCosts.amountCents) * 100)
        : undefined,
    testedHypotheses,
    costPerTestedHypothesis:
      testedHypotheses > 0 ? usd(Math.round(testSpend.amountCents / testedHypotheses)) : undefined,
  };
}
