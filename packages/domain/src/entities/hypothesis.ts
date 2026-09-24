import { z } from 'zod';
import {
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import { compareMoney, nonNegativeMoneySchema, positiveMoneySchema, type Money } from '../money.js';
import {
  countryCodeSchema,
  hypothesisIdSchema,
  metricSchema,
  opportunityIdSchema,
  text,
  type HypothesisId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/** How the hypothesis is tested; the five hypotheses must differ in how they validate (§7.1 Step B). */
export const VALIDATION_METHODS = [
  'landing_page',
  'demo',
  'clickable_prototype',
  'concierge',
  'preorder',
  'ads_test',
  'outreach',
  'interviews',
  'marketplace_listing',
  'waitlist',
  'other',
] as const;

export const HYPOTHESES_PER_OPPORTUNITY = 5;

export const HYPOTHESIS_STATUSES = [
  'proposed',
  'selected',
  'discarded',
  'testing',
  'confirmed',
  'refuted',
  'inconclusive',
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export const hypothesisLifecycle = defineStateMachine<HypothesisStatus>('hypothesis', {
  proposed: ['selected', 'discarded'],
  selected: ['testing', 'discarded'],
  testing: ['confirmed', 'refuted', 'inconclusive'],
  discarded: [],
  confirmed: [],
  refuted: [],
  inconclusive: [],
});

/** Fields of §7.1 Step B. */
const newHypothesisShape = {
  opportunityId: opportunityIdSchema,
  statement: text(1_000),
  audience: text(500),
  geo: countryCodeSchema,
  offer: text(500),
  price: nonNegativeMoneySchema,
  channel: text(100),
  /** Creative or demo shown to the audience. */
  creative: text(1_000),
  cta: text(200),
  validationMethod: z.enum(VALIDATION_METHODS),
  successMetric: metricSchema,
  budget: positiveMoneySchema,
  stopLoss: positiveMoneySchema,
  /** Minimum data needed before judging, e.g. "300 unique visitors". */
  minimumData: text(300),
  /** Lineage: the hypothesis this one refines. */
  parentId: hypothesisIdSchema.optional(),
};

function stopLossWithinBudget(value: { budget: Money; stopLoss: Money }): boolean {
  return compareMoney(value.stopLoss, value.budget) <= 0;
}
const STOP_LOSS_RULE = { message: 'stopLoss must not exceed budget', path: ['stopLoss'] };

export const newHypothesisSchema = z
  .strictObject(newHypothesisShape)
  .refine(stopLossWithinBudget, STOP_LOSS_RULE);
export type NewHypothesis = z.infer<typeof newHypothesisSchema>;

export const hypothesisSchema = z
  .object({
    ...newHypothesisShape,
    id: hypothesisIdSchema,
    status: z.enum(HYPOTHESIS_STATUSES),
    ...mutableMetaShape,
  })
  .refine(stopLossWithinBudget, STOP_LOSS_RULE);
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export function createHypothesis(
  data: NewHypothesis,
  context: CreateContext<HypothesisId>,
): Hypothesis {
  return parseEntity(hypothesisSchema, 'hypothesis', {
    ...data,
    id: context.id,
    status: 'proposed',
    ...mutableMeta(context),
  });
}

export function changeHypothesisStatus(
  hypothesis: Hypothesis,
  to: HypothesisStatus,
  context: DomainContext,
): Hypothesis {
  return transition(hypothesis, hypothesisLifecycle, hypothesisSchema, to, context);
}

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** What makes two hypotheses "the same test" (§7.1 Step B: not five copies of one creative). */
export function hypothesisKey(hypothesis: NewHypothesis): string {
  return JSON.stringify([
    normalize(hypothesis.audience),
    hypothesis.geo,
    normalize(hypothesis.offer),
    hypothesis.price.amountCents,
    normalize(hypothesis.channel),
    hypothesis.validationMethod,
  ]);
}

/**
 * The Five Hypothesis rule: exactly five hypotheses for one opportunity,
 * no two of them identical in audience, GEO, offer, price, channel and validation method.
 */
export function assertDistinctHypothesisSet(hypotheses: readonly NewHypothesis[]): void {
  const fail = (reason: string, details: Record<string, unknown> = {}): never => {
    throw new DomainError('invariant_violation', reason, details);
  };
  if (hypotheses.length !== HYPOTHESES_PER_OPPORTUNITY) {
    fail(`Exactly ${HYPOTHESES_PER_OPPORTUNITY} hypotheses are required`, {
      found: hypotheses.length,
    });
  }
  if (new Set(hypotheses.map((hypothesis) => hypothesis.opportunityId)).size > 1) {
    fail('All hypotheses must belong to the same opportunity');
  }
  const keys = hypotheses.map(hypothesisKey);
  const duplicates = keys
    .map((key, index) => (keys.indexOf(key) === index ? undefined : index))
    .filter((index) => index !== undefined);
  if (duplicates.length > 0) {
    fail('Hypotheses must differ in how they validate the opportunity', {
      duplicate_indexes: duplicates,
    });
  }
}
