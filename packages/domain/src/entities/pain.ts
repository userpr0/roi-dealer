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
import {
  countryCodeSchema,
  evidenceIdSchema,
  painIdSchema,
  signalIdSchema,
  text,
  titleSchema,
  uniqueList,
  type PainId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import { distinctSources, selectEvidence, type Evidence } from './evidence.js';

export const PAIN_FREQUENCIES = ['rare', 'occasional', 'frequent', 'constant'] as const;

/** Evidence first (§2.5): a validated pain needs evidence from at least this many sources. */
export const MIN_SOURCES_FOR_VALIDATED_PAIN = 2;

export const PAIN_STATUSES = ['candidate', 'validated', 'rejected', 'archived'] as const;
export type PainStatus = (typeof PAIN_STATUSES)[number];

export const painLifecycle = defineStateMachine<PainStatus>('pain', {
  candidate: ['validated', 'rejected', 'archived'],
  validated: ['archived'],
  rejected: [],
  archived: [],
});

const newPainShape = {
  title: titleSchema,
  description: text(5_000),
  /** Who suffers: the ideal customer profile in plain words. */
  audience: text(1_000),
  /** The result the audience wants — the basis of an outcome-first offer (§2.17). */
  desiredOutcome: text(1_000),
  severity: z.int().min(1).max(5),
  frequency: z.enum(PAIN_FREQUENCIES),
  markets: uniqueList(countryCodeSchema, { min: 1, max: 50 }),
  signalIds: uniqueList(signalIdSchema, { max: 100 }),
  evidenceIds: uniqueList(evidenceIdSchema, { min: 1, max: 200 }),
};

export const newPainSchema = z.strictObject(newPainShape);
export type NewPain = z.infer<typeof newPainSchema>;

export const painSchema = z.object({
  ...newPainShape,
  id: painIdSchema,
  status: z.enum(PAIN_STATUSES),
  ...mutableMetaShape,
});
export type Pain = z.infer<typeof painSchema>;

export function createPain(data: NewPain, context: CreateContext<PainId>): Pain {
  return parseEntity(painSchema, 'pain', {
    ...data,
    id: context.id,
    status: 'candidate',
    ...mutableMeta(context),
  });
}

/**
 * Marks a pain as validated. `evidence` must contain every item the pain references;
 * together they must come from at least {@link MIN_SOURCES_FOR_VALIDATED_PAIN} distinct sources.
 */
export function validatePain(
  pain: Pain,
  evidence: readonly Evidence[],
  context: DomainContext,
): Pain {
  const sources = distinctSources(selectEvidence(pain.evidenceIds, evidence));
  if (sources.size < MIN_SOURCES_FOR_VALIDATED_PAIN) {
    throw new DomainError(
      'evidence_required',
      `A validated pain needs evidence from at least ${MIN_SOURCES_FOR_VALIDATED_PAIN} sources`,
      { required_sources: MIN_SOURCES_FOR_VALIDATED_PAIN, found_sources: sources.size },
    );
  }
  return transition(pain, painLifecycle, painSchema, 'validated', context);
}

export function changePainStatus(
  pain: Pain,
  to: Exclude<PainStatus, 'validated' | 'candidate'>,
  context: DomainContext,
): Pain {
  return transition(pain, painLifecycle, painSchema, to, context);
}
