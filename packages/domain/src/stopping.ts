import { metricValue, readFunnelMeasure, type FunnelTotals } from './funnel.js';
import type { Metric } from './primitives.js';

/*
 * Statistical stopping (phase 26, ADR-0013): how likely a running test is to reach its success
 * metric, from its own funnel numbers and spend, computed in code (§2.13). A test that is
 * clearly below its target stops early and spends no more; a minimum of data guards against a
 * false verdict.
 */

/** Below this chance of reaching the target, with enough data, the test stops. */
export const FUTILITY_PROBABILITY = 0.05;
/** Above this chance, with enough data, the result is already clear. */
export const EARLY_WIN_PROBABILITY = 0.95;
/** A rate needs at least this many events at its base before the verdict counts. */
export const MIN_RATE_BASE = 100;
/** A count needs at least this share of the test budget spent before the verdict counts. */
export const MIN_SPEND_SHARE = 0.25;

const LANCZOS = [
  76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
  0.1208650973866179e-2, -0.5395239384953e-5,
];

function logGamma(x: number): number {
  let y = x;
  const base = x + 5.5;
  const tmp = base - (x + 0.5) * Math.log(base);
  let series = 1.000000000190015;
  for (const coefficient of LANCZOS) {
    y += 1;
    series += coefficient / y;
  }
  return -tmp + Math.log((2.5066282746310007 * series) / x);
}

/** Continued fraction of the incomplete beta function (Lentz's method). */
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-12) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b): P(X ≤ x) for X ~ Beta(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(a, b, x)) / a
    : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}

/** P(true rate ≥ target) after `successes` of `trials`, with a uniform prior. */
export function rateAtLeastProbability(
  successes: number,
  trials: number,
  targetShare: number,
): number {
  return 1 - betaCdf(targetShare, 1 + successes, 1 + Math.max(trials - successes, 0));
}

/**
 * P(the count reaches `target` with the rest of the budget): the events per dollar so far are
 * a Gamma posterior, so the events still to come are negative binomial.
 */
export function countReachProbability(
  count: number,
  target: number,
  spentCents: number,
  remainingCents: number,
): number {
  const need = Math.ceil(target - count);
  if (need <= 0) return 1;
  if (remainingCents <= 0) return 0;
  const shape = 1 + count;
  const q = spentCents / (spentCents + remainingCents);
  let pmf = Math.exp(shape * Math.log(q));
  let below = pmf;
  for (let k = 1; k < need; k += 1) {
    pmf *= ((k + shape - 1) / k) * (1 - q);
    below += pmf;
  }
  return Math.min(Math.max(1 - below, 0), 1);
}

export interface StoppingEvidence {
  /** How likely the metric is to reach its target, 0–1. */
  readonly probability: number;
  /** Whether there is enough data for the probability to stop the test or call it. */
  readonly enoughData: boolean;
}

/**
 * The chance a test reaches its success metric. A rate is judged on its own numbers; a count on
 * its pace per dollar against the budget left. `undefined` when there is nothing to judge yet.
 */
export function stoppingEvidence(
  metric: Metric,
  totals: FunnelTotals,
  spentCents: number,
  budgetCents: number,
): StoppingEvidence | undefined {
  const measure = readFunnelMeasure(metric);
  if (measure === undefined) return undefined;
  const count = totals[measure.stage] ?? 0;
  if (measure.per !== undefined) {
    const base = totals[measure.per] ?? 0;
    if (base === 0) return undefined;
    return {
      probability: rateAtLeastProbability(count, base, metric.target / 100),
      enoughData: base >= MIN_RATE_BASE,
    };
  }
  const value = metricValue(metric, totals) ?? 0;
  if (value >= metric.target) return { probability: 1, enoughData: true };
  if (spentCents <= 0) return undefined;
  return {
    probability: countReachProbability(
      count,
      metric.target,
      spentCents,
      Math.max(budgetCents - spentCents, 0),
    ),
    enoughData: spentCents >= budgetCents * MIN_SPEND_SHARE,
  };
}

/** Clearly below the target: enough data and a chance under `FUTILITY_PROBABILITY`. */
export function clearlyBelowTarget(evidence: StoppingEvidence | undefined): boolean {
  return (
    evidence !== undefined && evidence.enoughData && evidence.probability < FUTILITY_PROBABILITY
  );
}

/** Clearly above the target: enough data and a chance over `EARLY_WIN_PROBABILITY`. */
export function clearlyAboveTarget(evidence: StoppingEvidence | undefined): boolean {
  return (
    evidence !== undefined && evidence.enoughData && evidence.probability > EARLY_WIN_PROBABILITY
  );
}
