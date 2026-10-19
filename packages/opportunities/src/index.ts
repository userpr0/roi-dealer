/**
 * @roi-dealer/opportunities — Opportunity Engine (PHASE 07).
 *
 * The opportunity analyst takes pains seen at least twice: the AI (`frame-opportunity`) frames
 * each as an outcome-first opportunity and notes who buys, whether the problem recurs, its
 * urgency and quotes about money; code keeps only the quotes found in the evidence, computes the
 * score 0–100 from the database and picks the first business model by a fixed table. A score of
 * 55 or more becomes a draft Opportunity for the judges and the owner (PHASE 11–12).
 */
import type { AnyAiTask } from '@roi-dealer/ai-runtime';
import { frameOpportunityTask } from './tasks/frame-opportunity.js';

export {
  assessPains,
  assertOpportunitiesRunning,
  MIN_SIGNALS_FOR_OPPORTUNITY,
  OPPORTUNITY_ANALYST,
  OPPORTUNITY_ANALYST_ACCESS,
  opportunityFrom,
  type AssessmentOutcome,
  type AssessmentStop,
  type OpportunitiesDeps,
} from './assess.js';
export {
  ROUTING_REASONS,
  routeBusinessModel,
  type BusinessFeatures,
  type MonetizationModel,
  type RoutingReason,
} from './business-model.js';
export {
  OPPORTUNITY_THRESHOLD,
  SCORE_WEIGHTS,
  scoreOpportunity,
  type OpportunityScoreResult,
  type ScoreInput,
  type ScorePart,
} from './scoring.js';
export {
  frameOpportunityTask,
  MAX_EXCERPTS,
  scoreFrameOpportunity,
  toOpportunityDraft,
  verifiedQuotes,
  type FrameOpportunityExpected,
  type FrameOpportunityInput,
  type FrameOpportunityOutput,
  type OpportunityDraft,
} from './tasks/frame-opportunity.js';

/** The AI tasks of this package; the worker evaluates them with the others. */
export const OPPORTUNITY_TASKS: readonly AnyAiTask[] = [frameOpportunityTask];

export const PACKAGE_NAME = '@roi-dealer/opportunities';
