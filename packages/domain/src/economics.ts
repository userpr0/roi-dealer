import { compareMoney, subtractMoney, usd, type Money } from './money.js';
import type { CostCategory } from './entities/cost.js';

/*
 * Economics (PHASE 16): the monthly limits of D-007, unit economics of a test and the spend
 * anomaly rule of D-014 п.10 — all computed in code from the ledgers (§2.13, §7.3).
 */

/** Monthly limits by category (D-007); other categories have no monthly limit (D-006 applies). */
export const MONTHLY_LIMITS: Readonly<Partial<Record<CostCategory, Money>>> = {
  infrastructure: usd(2_000),
  ai: usd(5_000),
};
/** A category at 80 % of its limit is a warning. */
export const BUDGET_WARNING_SHARE = 0.8;

export type BudgetState = 'ok' | 'warning' | 'over';

export function budgetState(spent: Money, limit: Money): BudgetState {
  if (compareMoney(spent, limit) >= 0) return 'over';
  return spent.amountCents >= limit.amountCents * BUDGET_WARNING_SHARE ? 'warning' : 'ok';
}

export interface MoneyFlow {
  /** What the test cost, refunds excluded. */
  readonly spend: Money;
  readonly payments: Money;
  readonly preorders: Money;
  /** Money returned to customers. */
  readonly refunds: Money;
  readonly customers: number;
}

export interface UnitEconomics {
  readonly netRevenue: Money;
  /** Spend per customer; absent without customers. */
  readonly cac?: Money | undefined;
  /** Net revenue per customer; absent without customers. */
  readonly revenuePerCustomer?: Money | undefined;
  /** (net revenue − spend) / spend, in percent rounded to whole; absent without spend. */
  readonly roiPercent?: number | undefined;
}

/** Unit economics of a test or an opportunity; no divisor — no value (§2.13). */
export function unitEconomics(flow: MoneyFlow): UnitEconomics {
  const gross = flow.payments.amountCents + flow.preorders.amountCents;
  const netRevenue = subtractMoney(usd(gross), flow.refunds);
  const spend = flow.spend.amountCents;
  return {
    netRevenue,
    cac: flow.customers > 0 ? usd(Math.round(spend / flow.customers)) : undefined,
    revenuePerCustomer:
      flow.customers > 0 ? usd(Math.round(netRevenue.amountCents / flow.customers)) : undefined,
    roiPercent:
      spend > 0 ? Math.round(((netRevenue.amountCents - spend) / spend) * 100) : undefined,
  };
}

/** The auto-pause rule (D-014 п.10): today's automated spend against the last seven days. */
export const SPEND_ANOMALY_FACTOR = 2;
/** Below this a day is never anomalous: early days have no meaningful average. */
export const SPEND_ANOMALY_FLOOR_MICRO_USD = 5_000_000;
export const SPEND_ANOMALY_DAYS = 7;

export interface SpendAnomaly {
  readonly anomalous: boolean;
  /** Average of the previous days, micro-USD. */
  readonly averageMicroUsd: number;
  /** Today's spend that triggers the pause, micro-USD. */
  readonly thresholdMicroUsd: number;
}

/**
 * Whether today's automated spend is anomalous: at least twice the average of the previous
 * seven days and at least the floor. `previousDays` are the daily totals before today.
 */
export function spendAnomaly(todayMicroUsd: number, previousDays: readonly number[]): SpendAnomaly {
  const days = previousDays.slice(-SPEND_ANOMALY_DAYS);
  const averageMicroUsd =
    days.length === 0 ? 0 : Math.round(days.reduce((sum, day) => sum + day, 0) / days.length);
  const thresholdMicroUsd = Math.max(
    SPEND_ANOMALY_FACTOR * averageMicroUsd,
    SPEND_ANOMALY_FLOOR_MICRO_USD,
  );
  return { anomalous: todayMicroUsd >= thresholdMicroUsd, averageMicroUsd, thresholdMicroUsd };
}
