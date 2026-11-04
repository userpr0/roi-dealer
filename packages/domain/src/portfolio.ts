import { z } from 'zod';
import { forecastProbability } from './forecast.js';

/*
 * The portfolio of tests (phase 26, ADR-0013): the owner sets the month's test budget and the
 * limits per country and per opportunity; code recommends which hypotheses get money this month
 * by Thompson sampling over what the tests showed so far. The owner still launches each test
 * with an approved `experiment_launch`.
 */

/** A hypothesis's forecast counts as this many tests before its own results (phase 25). */
export const PORTFOLIO_PRIOR_WEIGHT = 2;
/** Upper bound of a month's test budget the bot accepts. */
export const MAX_PORTFOLIO_CENTS = 1_000_000;

export const portfolioLimitsSchema = z
  .strictObject({
    totalCents: z.int().min(100).max(MAX_PORTFOLIO_CENTS),
    countryCents: z.int().min(100).max(MAX_PORTFOLIO_CENTS),
    opportunityCents: z.int().min(100).max(MAX_PORTFOLIO_CENTS),
  })
  .refine((limits) => limits.countryCents <= limits.totalCents, {
    error: 'the country limit is above the month budget',
    path: ['countryCents'],
  })
  .refine((limits) => limits.opportunityCents <= limits.totalCents, {
    error: 'the opportunity limit is above the month budget',
    path: ['opportunityCents'],
  });
export type PortfolioLimits = z.infer<typeof portfolioLimitsSchema>;

/** Money already taken this month: tests started this month and launches requested or approved. */
export interface PortfolioCommitted {
  readonly totalCents: number;
  readonly byCountry: Readonly<Record<string, number>>;
  readonly byOpportunity: Readonly<Record<string, number>>;
}

export interface PortfolioCandidate {
  readonly hypothesisId: string;
  readonly opportunityId: string;
  readonly geo: string;
  readonly budgetCents: number;
  /** The opportunity score 0–100 (PHASE 07); read as the prior by the forecast rules. */
  readonly score: number;
  /** Results of the opportunity's earlier tests. */
  readonly confirmed: number;
  readonly refuted: number;
}

export type PortfolioSkip = 'total' | 'country' | 'opportunity';

export interface PortfolioPick {
  readonly candidate: PortfolioCandidate;
  /** The mean chance of success, α / (α + β). */
  readonly chance: number;
  /** The Thompson draw that ranked it. */
  readonly draw: number;
}

export interface PortfolioRecommendation {
  readonly picks: readonly PortfolioPick[];
  readonly skipped: readonly (PortfolioPick & { readonly reason: PortfolioSkip })[];
  readonly freeCents: number;
}

/** FNV-1a: a stable seed from text. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** mulberry32: uniform numbers in (0, 1), reproducible from the seed. */
function uniforms(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4_294_967_296;
  };
}

/** Gamma(shape ≥ 1, 1) by Marsaglia and Tsang. */
function gamma(shape: number, uniform: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = uniform();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** The Beta posterior of a hypothesis: its forecast as a prior plus its opportunity's results. */
export function portfolioPosterior(candidate: PortfolioCandidate): {
  readonly alpha: number;
  readonly beta: number;
} {
  const prior = forecastProbability(candidate.score);
  return {
    alpha: 1 + PORTFOLIO_PRIOR_WEIGHT * prior + candidate.confirmed,
    beta: 1 + PORTFOLIO_PRIOR_WEIGHT * (1 - prior) + candidate.refuted,
  };
}

/**
 * Which hypotheses get money this month: one Thompson draw per hypothesis (seeded by the month,
 * so the advice stays the same within it), highest first, while the month budget and the limits
 * per country and per opportunity allow.
 */
export function recommendPortfolio(input: {
  readonly month: string;
  readonly limits: PortfolioLimits;
  readonly committed: PortfolioCommitted;
  readonly candidates: readonly PortfolioCandidate[];
}): PortfolioRecommendation {
  const ids = input.candidates.map((item) => item.hypothesisId).sort();
  const uniform = uniforms(hash(`${input.month}|${ids.join(',')}`));
  const ranked = [...input.candidates]
    .sort((a, b) => a.hypothesisId.localeCompare(b.hypothesisId))
    .map((candidate) => {
      const { alpha, beta } = portfolioPosterior(candidate);
      const x = gamma(alpha, uniform);
      const y = gamma(beta, uniform);
      return {
        candidate,
        chance: Math.round((alpha / (alpha + beta)) * 1_000) / 1_000,
        draw: Math.round((x / (x + y)) * 1_000) / 1_000,
      };
    })
    .sort(
      (a, b) => b.draw - a.draw || a.candidate.hypothesisId.localeCompare(b.candidate.hypothesisId),
    );

  let free = Math.max(input.limits.totalCents - input.committed.totalCents, 0);
  const country = new Map(Object.entries(input.committed.byCountry));
  const opportunity = new Map(Object.entries(input.committed.byOpportunity));
  const picks: PortfolioPick[] = [];
  const skipped: (PortfolioPick & { reason: PortfolioSkip })[] = [];
  for (const pick of ranked) {
    const { geo, opportunityId, budgetCents } = pick.candidate;
    const inCountry = (country.get(geo) ?? 0) + budgetCents;
    const inOpportunity = (opportunity.get(opportunityId) ?? 0) + budgetCents;
    const reason: PortfolioSkip | undefined =
      budgetCents > free
        ? 'total'
        : inCountry > input.limits.countryCents
          ? 'country'
          : inOpportunity > input.limits.opportunityCents
            ? 'opportunity'
            : undefined;
    if (reason !== undefined) {
      skipped.push({ ...pick, reason });
      continue;
    }
    picks.push(pick);
    free -= budgetCents;
    country.set(geo, inCountry);
    opportunity.set(opportunityId, inOpportunity);
  }
  return { picks, skipped, freeCents: free };
}
