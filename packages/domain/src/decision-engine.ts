import type { DecisionOutcome } from './entities/decision.js';
import type { JudgePanel } from './judgement.js';

/*
 * Decision Engine (PHASE 12): what the system recommends for an opportunity under review,
 * computed from the judges' panel by fixed rules (§2.13). It is shown on the decision card; only
 * the owner decides (§2.7).
 */

/** The decisions the owner can make on an opportunity under review. */
export const REVIEW_OUTCOMES = [
  'approve',
  'reject',
  'more_research',
] as const satisfies readonly DecisionOutcome[];
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export type RecommendationReason =
  /** Not every criterion has a score. */
  | 'incomplete'
  /** Market, pain or economics scored 1, or the risk is high (1). */
  | 'critical_weakness'
  /** The judges' total is under 40. */
  | 'low_total'
  /** A total of 65 or more and no weak spot. */
  | 'strong'
  /** Anything in between: weak spots to check first. */
  | 'mixed';

export interface Recommendation {
  readonly outcome: ReviewOutcome;
  readonly reason: RecommendationReason;
}

export const APPROVE_TOTAL = 65;
export const REJECT_TOTAL = 40;

/** The system's recommendation for an opportunity from its judges' panel. */
export function recommendOpportunity(panel: JudgePanel): Recommendation {
  if (panel.total === undefined) return { outcome: 'more_research', reason: 'incomplete' };
  const { scores } = panel;
  if (
    scores.market === 1 ||
    scores.pain_value === 1 ||
    scores.economics === 1 ||
    scores.risk === 1
  ) {
    return { outcome: 'reject', reason: 'critical_weakness' };
  }
  if (panel.total < REJECT_TOTAL) return { outcome: 'reject', reason: 'low_total' };
  if (panel.total >= APPROVE_TOTAL && panel.weak.length === 0) {
    return { outcome: 'approve', reason: 'strong' };
  }
  return { outcome: 'more_research', reason: 'mixed' };
}
