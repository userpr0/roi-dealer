/*
 * AI budget (D-007, D-021): $50 a month, spread over the days left so every day keeps its
 * share; never more than $20 a day (the D-006 gate of the daily CostEntry). Amounts are in
 * micro-USD: one call costs fractions of a cent.
 */

export const MICRO_USD_PER_USD = 1_000_000;

export interface AiBudgetLimits {
  readonly monthlyMicroUsd: number;
  /** Hard cap of one UTC day. */
  readonly dailyCapMicroUsd: number;
}

export const AI_BUDGET_LIMITS: AiBudgetLimits = {
  monthlyMicroUsd: 50 * MICRO_USD_PER_USD,
  dailyCapMicroUsd: 20 * MICRO_USD_PER_USD,
};

const DAY_MS = 24 * 3_600_000;

export function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Days of the UTC month from today to its end, today included. */
export function daysLeftInUtcMonth(ms: number): number {
  const date = new Date(ms);
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return Math.round((nextMonth - startOfUtcDay(ms)) / DAY_MS);
}

/**
 * Today's AI allowance: what is left of the month before today, divided by the days left;
 * a quiet day leaves more for the next ones. Never above the daily cap, never below zero.
 */
export function dailyAiAllowanceMicroUsd(
  limits: AiBudgetLimits,
  spentThisMonthBeforeTodayMicroUsd: number,
  nowMs: number,
): number {
  const left = Math.max(0, limits.monthlyMicroUsd - spentThisMonthBeforeTodayMicroUsd);
  return Math.min(limits.dailyCapMicroUsd, Math.floor(left / daysLeftInUtcMonth(nowMs)));
}
