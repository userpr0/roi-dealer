/*
 * The "Pulse" (05c, ADR-0012): whether interest in a topic is rising, computed in code from a
 * daily series (§2.13) — never by AI. The recent window is compared with a baseline of the weeks
 * before it.
 */

/** How far ahead the Pulse looks: six weeks. */
export const PULSE_WINDOW_DAYS = 42;

export const TREND_DIRECTIONS = ['rising', 'falling', 'flat', 'insufficient'] as const;
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];

export interface TrendOptions {
  /** Days of the recent window, ending with `today`. Default 7. */
  readonly recentDays?: number;
  /** Days of the baseline before the recent window. Default 28. */
  readonly baselineDays?: number;
  /** Recent ÷ baseline at or above this is rising. Default 1.5. */
  readonly risingRatio?: number;
  /** Recent ÷ baseline at or below this is falling. Default 0.67. */
  readonly fallingRatio?: number;
}

export interface InterestTrend {
  readonly direction: TrendDirection;
  /** Average per day of the recent window; absent when there are too few points. */
  readonly recentAverage?: number;
  readonly baselineAverage?: number;
  /** Recent ÷ baseline, rounded to two decimals. */
  readonly ratio?: number;
}

const DAY_MS = 86_400_000;

function dayIndex(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new RangeError(`invalid day: ${day}`);
  return Math.round(ms / DAY_MS);
}

/** The day `days` after `day` (negative: before), `YYYY-MM-DD`. */
export function addDays(day: string, days: number): string {
  return new Date((dayIndex(day) + days) * DAY_MS).toISOString().slice(0, 10);
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The trend of a daily series on `today`. A window needs at least half of its days present,
 * otherwise the trend is `insufficient`; so is a baseline of zero.
 */
export function interestTrend(
  points: readonly { readonly day: string; readonly value: number }[],
  today: string,
  options: TrendOptions = {},
): InterestTrend {
  const recentDays = options.recentDays ?? 7;
  const baselineDays = options.baselineDays ?? 28;
  const rising = options.risingRatio ?? 1.5;
  const falling = options.fallingRatio ?? 0.67;
  const end = dayIndex(today);
  const recentStart = end - recentDays + 1;
  const baselineStart = recentStart - baselineDays;

  const recent: number[] = [];
  const baseline: number[] = [];
  for (const point of points) {
    const index = dayIndex(point.day);
    if (index >= recentStart && index <= end) recent.push(point.value);
    else if (index >= baselineStart && index < recentStart) baseline.push(point.value);
  }
  if (recent.length * 2 < recentDays || baseline.length * 2 < baselineDays) {
    return { direction: 'insufficient' };
  }
  const recentAverage = average(recent);
  const baselineAverage = average(baseline);
  if (baselineAverage <= 0) return { direction: 'insufficient', recentAverage, baselineAverage };
  const ratio = Math.round((recentAverage / baselineAverage) * 100) / 100;
  const direction: TrendDirection =
    ratio >= rising ? 'rising' : ratio <= falling ? 'falling' : 'flat';
  return { direction, recentAverage, baselineAverage, ratio };
}
