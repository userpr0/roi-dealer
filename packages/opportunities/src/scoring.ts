import { inTargetMarkets, type Pain } from '@roi-dealer/domain';

/*
 * Opportunity score 0–100 (PHASE 07): computed in code from the database (§2.13). The AI only
 * says who buys; everything else is the pain's own data and the quotes code verified.
 */

/** Points of each part; they add up to 100. */
export const SCORE_WEIGHTS = {
  frequency: 25,
  severity: 20,
  sources: 15,
  willingness: 20,
  market: 10,
  buyer: 10,
} as const;
export type ScorePart = keyof typeof SCORE_WEIGHTS;

/** A draft opportunity is created at this score or above. */
export const OPPORTUNITY_THRESHOLD = 55;

const FREQUENCY_VALUE: Readonly<Record<Pain['frequency'], number>> = {
  rare: 0.25,
  occasional: 0.5,
  frequent: 0.8,
  constant: 1,
};

export interface ScoreInput {
  readonly pain: Pick<Pain, 'frequency' | 'severity' | 'markets'>;
  /** Distinct sources of the pain's evidence. */
  readonly sources: number;
  /** Quotes about money spent or lost that code found in the evidence. */
  readonly verifiedPaymentQuotes: number;
  readonly buyer: 'business' | 'consumer';
}

export interface OpportunityScoreResult {
  readonly total: number;
  readonly components: Readonly<Record<ScorePart, number>>;
}

const points = (part: ScorePart, value: number) =>
  Math.round(SCORE_WEIGHTS[part] * Math.min(Math.max(value, 0), 1) * 10) / 10;

export function scoreOpportunity(input: ScoreInput): OpportunityScoreResult {
  const components: Record<ScorePart, number> = {
    frequency: points('frequency', FREQUENCY_VALUE[input.pain.frequency]),
    severity: points('severity', (input.pain.severity - 1) / 4),
    sources: points('sources', input.sources >= 2 ? 1 : input.sources === 1 ? 0.5 : 0),
    willingness: points(
      'willingness',
      input.verifiedPaymentQuotes >= 2 ? 1 : input.verifiedPaymentQuotes === 1 ? 0.6 : 0,
    ),
    market: points('market', inTargetMarkets(input.pain.markets) ? 1 : 0.3),
    buyer: points('buyer', input.buyer === 'business' ? 1 : 0.5),
  };
  const total = Math.round(Object.values(components).reduce((sum, value) => sum + value, 0));
  return { total, components };
}
