/*
 * Forecast vs fact (phase 25, ADR-0013): when a test starts, code records how likely its success
 * metric is to be reached; when the owner records the result, the fact. The accuracy (Brier
 * score) is computed in code per version of the rules (§2.13). New rules are only proposed —
 * the owner approves a new version.
 */

/** The version of the forecast rules; a new version only by an owner decision. */
export const FORECAST_RULES_VERSION = 1;

/** A forecast never says "certain": the probability stays within these bounds. */
export const MIN_FORECAST_PROBABILITY = 0.05;
export const MAX_FORECAST_PROBABILITY = 0.95;

/** Proposing new weights needs at least this many tests with a clear result (ADR-0013). */
export const WEIGHTS_PROPOSAL_MIN_OUTCOMES = 20;

/** Brier score of always saying 50 %: a forecast is useful only below it. */
export const COIN_BRIER = 0.25;

export const FORECAST_VERDICTS = ['confirmed', 'refuted', 'inconclusive'] as const;
export type ForecastVerdict = (typeof FORECAST_VERDICTS)[number];

/** What a test looked like when it started: the inputs the rules saw, kept for calibration. */
export interface LaunchSignals {
  /** The opportunity score 0–100 and its parts in points (PHASE 07). */
  readonly score: number;
  readonly components: Readonly<Record<string, number>>;
  /** The judges' total 0–100 (PHASE 11), when the panel is complete. */
  readonly judgesTotal?: number | undefined;
  readonly method: string;
  readonly geo: string;
  readonly priceCents: number;
  readonly budgetCents: number;
  readonly metric: string;
  readonly target: number;
}

export interface LaunchForecast {
  readonly rulesVersion: number;
  readonly probability: number;
  readonly signals: LaunchSignals;
}

const round3 = (value: number) => Math.round(value * 1_000) / 1_000;

/** Rules v1: the opportunity score read as a probability, never 0 or 1. */
export function forecastProbability(score: number): number {
  const value = Number.isFinite(score) ? score / 100 : 0;
  return round3(Math.min(Math.max(value, MIN_FORECAST_PROBABILITY), MAX_FORECAST_PROBABILITY));
}

export function launchForecast(signals: LaunchSignals): LaunchForecast {
  return {
    rulesVersion: FORECAST_RULES_VERSION,
    probability: forecastProbability(signals.score),
    signals,
  };
}

/** A recorded forecast and, once the test is closed, its fact. */
export interface ForecastRecord {
  readonly rulesVersion: number;
  readonly probability: number;
  readonly verdict?: ForecastVerdict | undefined;
}

export interface Calibration {
  readonly rulesVersion: number;
  /** Tests with a forecast. */
  readonly forecasts: number;
  /** Of them, with a clear result: confirmed or refuted. */
  readonly resolved: number;
  /** Mean forecast and the share that succeeded, over the resolved tests. */
  readonly expectedRate?: number | undefined;
  readonly observedRate?: number | undefined;
  /** Mean of (probability − fact)²: 0 is perfect, 0.25 is a coin. */
  readonly brier?: number | undefined;
}

/**
 * Accuracy per version of the rules, newest version first. An inconclusive result (the owner
 * closed the test before the stop-loss or the budget) says nothing about the forecast and is
 * left out.
 */
export function calibration(records: readonly ForecastRecord[]): Calibration[] {
  const versions = [...new Set(records.map((item) => item.rulesVersion))].sort((a, b) => b - a);
  return versions.map((rulesVersion) => {
    const own = records.filter((item) => item.rulesVersion === rulesVersion);
    const resolved = own.filter(
      (item) => item.verdict === 'confirmed' || item.verdict === 'refuted',
    );
    if (resolved.length === 0) return { rulesVersion, forecasts: own.length, resolved: 0 };
    const fact = (item: ForecastRecord) => (item.verdict === 'confirmed' ? 1 : 0);
    const mean = (values: readonly number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      rulesVersion,
      forecasts: own.length,
      resolved: resolved.length,
      expectedRate: round3(mean(resolved.map((item) => item.probability))),
      observedRate: round3(mean(resolved.map(fact))),
      brier: round3(mean(resolved.map((item) => (item.probability - fact(item)) ** 2))),
    };
  });
}
