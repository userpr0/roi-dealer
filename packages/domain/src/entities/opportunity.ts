import { z } from 'zod';
import {
  assertOwner,
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import {
  countryCodeSchema,
  decisionIdSchema,
  opportunityIdSchema,
  painIdSchema,
  text,
  titleSchema,
  uniqueList,
  type OpportunityId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import type { Decision, DecisionOutcome } from './decision.js';

/** Monetization is a hypothesis (§2.18). */
export const MONETIZATION_MODELS = [
  'free_limit',
  'subscription',
  'one_time',
  'setup_fee',
  'bundle',
  'usage_based',
  'outcome_based',
  'lifetime_deal',
  'service',
  'marketplace',
  'affiliate',
  'advertising',
  'licensing',
  'other',
] as const;

export const OPPORTUNITY_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'rejected',
  'validating',
  'paused',
  'scaling',
  'killed',
  'archived',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const opportunityLifecycle = defineStateMachine<OpportunityStatus>('opportunity', {
  draft: ['under_review', 'archived'],
  under_review: ['approved', 'rejected', 'draft'],
  approved: ['validating', 'paused', 'killed'],
  validating: ['scaling', 'paused', 'killed'],
  paused: ['validating', 'killed'],
  scaling: ['paused', 'killed'],
  rejected: [],
  killed: [],
  archived: [],
});

/** Outcome-first value proposition (§2.17): problem, change, measurable result, proof. */
export const valuePropositionSchema = z.strictObject({
  problem: text(1_000),
  change: text(1_000),
  measurableResult: text(500),
  proof: text(1_000).optional(),
});

const newOpportunityShape = {
  title: titleSchema,
  summary: text(3_000),
  painIds: uniqueList(painIdSchema, { min: 1, max: 20 }),
  /** Ideal customer profile. */
  icp: text(1_000),
  markets: uniqueList(countryCodeSchema, { min: 1, max: 50 }),
  valueProposition: valuePropositionSchema,
  businessModel: z.strictObject({
    model: z.enum(MONETIZATION_MODELS),
    pricingHypothesis: text(500).optional(),
  }),
  /** Lineage: set when this opportunity is a pivot of another one. */
  parentId: opportunityIdSchema.optional(),
};

export const newOpportunitySchema = z.strictObject(newOpportunityShape);
export type NewOpportunity = z.infer<typeof newOpportunitySchema>;

export const opportunitySchema = z.object({
  ...newOpportunityShape,
  id: opportunityIdSchema,
  status: z.enum(OPPORTUNITY_STATUSES),
  lastDecisionId: decisionIdSchema.optional(),
  ...mutableMetaShape,
});
export type Opportunity = z.infer<typeof opportunitySchema>;

export function createOpportunity(
  data: NewOpportunity,
  context: CreateContext<OpportunityId>,
): Opportunity {
  return parseEntity(opportunitySchema, 'opportunity', {
    ...data,
    id: context.id,
    status: 'draft',
    ...mutableMeta(context),
  });
}

/** Puts the opportunity in front of the owner (Decision Engine queue). */
export function submitOpportunityForReview(
  opportunity: Opportunity,
  context: DomainContext,
): Opportunity {
  return transition(opportunity, opportunityLifecycle, opportunitySchema, 'under_review', context);
}

/** Called when the first experiment of an approved opportunity starts. */
export function startOpportunityValidation(
  opportunity: Opportunity,
  context: DomainContext,
): Opportunity {
  return transition(opportunity, opportunityLifecycle, opportunitySchema, 'validating', context);
}

export function archiveOpportunity(opportunity: Opportunity, context: DomainContext): Opportunity {
  return transition(opportunity, opportunityLifecycle, opportunitySchema, 'archived', context);
}

const DECISION_TARGET: Readonly<Record<DecisionOutcome, OpportunityStatus>> = {
  approve: 'approved',
  reject: 'rejected',
  more_research: 'draft',
  pause: 'paused',
  kill: 'killed',
  scale: 'scaling',
  improve: 'validating',
  pivot: 'killed',
};

/**
 * The only way the owner's judgement changes an opportunity: through a recorded Decision.
 * `pivot` closes this opportunity; the caller creates the new one with `parentId`.
 */
export function applyOpportunityDecision(
  opportunity: Opportunity,
  decision: Decision,
): Opportunity {
  if (decision.subject.type !== 'opportunity' || decision.subject.id !== opportunity.id) {
    throw new DomainError('invariant_violation', 'Decision is about a different subject', {
      decision_id: decision.id,
    });
  }
  assertOwner(decision.createdBy, 'decide on opportunities');

  const context = { actor: decision.createdBy, at: decision.createdAt };
  const target = DECISION_TARGET[decision.outcome];

  if (decision.outcome === 'improve' && opportunity.status === 'validating') {
    // Another validation cycle: the status stays, the decision is linked.
    return parseEntity(opportunitySchema, 'opportunity', {
      ...opportunity,
      lastDecisionId: decision.id,
      updatedAt: context.at,
      version: opportunity.version + 1,
    });
  }
  return transition(opportunity, opportunityLifecycle, opportunitySchema, target, context, {
    lastDecisionId: decision.id,
  });
}
