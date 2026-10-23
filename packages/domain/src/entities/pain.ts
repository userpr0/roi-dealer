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
  evidenceIdSchema,
  painIdSchema,
  signalIdSchema,
  text,
  timestampSchema,
  titleSchema,
  uniqueList,
  type PainId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import { distinctSources, selectEvidence, type Evidence } from './evidence.js';
import type { Signal } from './signal.js';

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
  /** The owner confirmed the pain in /pains (D-030): it goes first to the opportunity engine. */
  ownerConfirmedAt: timestampSchema.optional(),
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

/** A pain holds at most this many signals and evidence items (PHASE 01 limits). */
export const MAX_PAIN_SIGNALS = 100;
export const MAX_PAIN_EVIDENCE = 200;
const MAX_PAIN_MARKETS = 50;

/** Severity of a pain first seen in a signal of this strength (PHASE 06). */
export const SEVERITY_BY_STRENGTH: Readonly<Record<Signal['strength'], number>> = {
  weak: 2,
  moderate: 3,
  strong: 4,
};

/** How often the pain is observed: by the number of its signals (PHASE 06). */
export function frequencyForSignals(count: number): (typeof PAIN_FREQUENCIES)[number] {
  if (count >= 15) return 'constant';
  if (count >= 5) return 'frequent';
  if (count >= 2) return 'occasional';
  return 'rare';
}

/** Whether another signal fits into the pain. */
export function painHasRoom(pain: Pain): boolean {
  return pain.signalIds.length < MAX_PAIN_SIGNALS;
}

/**
 * Adds a signal that describes the same pain (PHASE 06): its evidence and markets join the
 * pain (up to the limits), severity keeps the strongest signal, frequency follows the number of
 * signals. Only open pains (`candidate`, `validated`) take signals.
 */
export function addSignalToPain(pain: Pain, signal: Signal, context: DomainContext): Pain {
  if (pain.status !== 'candidate' && pain.status !== 'validated') {
    throw new DomainError('invalid_transition', 'Only an open pain takes new signals', {
      pain_id: pain.id,
      status: pain.status,
    });
  }
  if (pain.signalIds.includes(signal.id)) {
    throw new DomainError('invariant_violation', 'The signal is already part of the pain', {
      pain_id: pain.id,
      signal_id: signal.id,
    });
  }
  if (!painHasRoom(pain)) {
    throw new DomainError('invariant_violation', 'The pain holds the maximum number of signals', {
      pain_id: pain.id,
      max_signals: MAX_PAIN_SIGNALS,
    });
  }
  const signalIds = [...pain.signalIds, signal.id];
  const newEvidence = signal.evidenceIds.filter((id) => !pain.evidenceIds.includes(id));
  const evidenceIds = [...pain.evidenceIds, ...newEvidence].slice(0, MAX_PAIN_EVIDENCE);
  const markets = [...new Set([...pain.markets, ...signal.markets])].slice(0, MAX_PAIN_MARKETS);
  return parseEntity(painSchema, 'pain', {
    ...pain,
    signalIds,
    evidenceIds,
    markets,
    severity: Math.max(pain.severity, SEVERITY_BY_STRENGTH[signal.strength]),
    frequency: frequencyForSignals(signalIds.length),
    updatedAt: context.at,
    version: pain.version + 1,
  });
}

export function changePainStatus(
  pain: Pain,
  to: Exclude<PainStatus, 'validated' | 'candidate'>,
  context: DomainContext,
): Pain {
  return transition(pain, painLifecycle, painSchema, to, context);
}

function assertOpen(pain: Pain): void {
  if (pain.status !== 'candidate' && pain.status !== 'validated') {
    throw new DomainError('invalid_transition', 'The pain is closed', {
      pain_id: pain.id,
      status: pain.status,
    });
  }
}

/**
 * The owner confirms an open pain (D-030): «беру в работу». It does not validate the pain —
 * that needs evidence from {@link MIN_SOURCES_FOR_VALIDATED_PAIN} sources (§2.5).
 */
export function confirmPainByOwner(pain: Pain, context: DomainContext): Pain {
  assertOwner(context.actor, 'confirm a pain');
  assertOpen(pain);
  if (pain.ownerConfirmedAt !== undefined) {
    throw new DomainError('invalid_transition', 'The pain is already confirmed', {
      pain_id: pain.id,
    });
  }
  return parseEntity(painSchema, 'pain', {
    ...pain,
    ownerConfirmedAt: context.at,
    updatedAt: context.at,
    version: pain.version + 1,
  });
}

/** Rating weights (D-030): independent sources weigh most. */
export const PAIN_RATING = {
  perSource: 13,
  maxSources: 5,
  signals: 10,
  maxSignals: 15,
  severity: 15,
  ownerConfirmed: 10,
} as const;

/** A favorite pain is confirmed by evidence from at least two distinct sources (§2.5, D-030). */
export function isFavoritePain(sourceCount: number): boolean {
  return sourceCount >= MIN_SOURCES_FOR_VALIDATED_PAIN;
}

/**
 * The pain's rating 0–100, computed in code (D-030, §2.13): up to 65 for distinct sources
 * (13 each, up to 5), up to 10 for signals, up to 15 for severity and 10 when the owner
 * confirmed it. At equal severity one more independent source outweighs any number of signals.
 */
export function painRating(pain: Pain, sourceCount: number): number {
  const sources = Math.min(Math.max(sourceCount, 0), PAIN_RATING.maxSources);
  const signals = Math.min(pain.signalIds.length, PAIN_RATING.maxSignals);
  const score =
    sources * PAIN_RATING.perSource +
    (signals / PAIN_RATING.maxSignals) * PAIN_RATING.signals +
    (pain.severity / 5) * PAIN_RATING.severity +
    (pain.ownerConfirmedAt === undefined ? 0 : PAIN_RATING.ownerConfirmed);
  return Math.round(score);
}
