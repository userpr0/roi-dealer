import { z } from 'zod';
import { immutableMeta, immutableMetaShape, parseEntity, type CreateContext } from '../entity.js';
import { DomainError } from '../errors.js';
import {
  countryCodeSchema,
  evidenceIdSchema,
  httpUrlSchema,
  languageTagSchema,
  sourceIdSchema,
  text,
  timestampMs,
  timestampSchema,
  type EvidenceId,
  type SourceId,
} from '../primitives.js';

export const EVIDENCE_KINDS = [
  'quote',
  'review',
  'post',
  'metric',
  'price',
  'search_trend',
  'observation',
  'document',
  'other',
] as const;

const newEvidenceShape = {
  sourceId: sourceIdSchema,
  kind: z.enum(EVIDENCE_KINDS),
  /** Verbatim excerpt or measured value, as observed. */
  excerpt: text(5_000),
  url: httpUrlSchema.optional(),
  observedAt: timestampSchema,
  market: countryCodeSchema.optional(),
  language: languageTagSchema.optional(),
};

/** An immutable fact captured from a source. Corrections are new Evidence (§2.2). */
export const newEvidenceSchema = z.strictObject(newEvidenceShape);
export type NewEvidence = z.infer<typeof newEvidenceSchema>;

export const evidenceSchema = z
  .object({ ...newEvidenceShape, id: evidenceIdSchema, ...immutableMetaShape })
  .refine((evidence) => timestampMs(evidence.observedAt) <= timestampMs(evidence.createdAt), {
    message: 'observedAt must not be later than createdAt',
    path: ['observedAt'],
  });
export type Evidence = z.infer<typeof evidenceSchema>;

export function createEvidence(data: NewEvidence, context: CreateContext<EvidenceId>): Evidence {
  return parseEntity(evidenceSchema, 'evidence', {
    ...data,
    id: context.id,
    ...immutableMeta(context),
  });
}

/**
 * Returns the evidence items referenced by `ids`, in that order.
 * Throws `evidence_required` when any referenced item is missing from `provided`.
 */
export function selectEvidence(
  ids: readonly EvidenceId[],
  provided: readonly Evidence[],
): Evidence[] {
  const byId = new Map(provided.map((item) => [item.id, item]));
  const selected: Evidence[] = [];
  const missing: EvidenceId[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined) missing.push(id);
    else selected.push(item);
  }
  if (missing.length > 0) {
    throw new DomainError('evidence_required', 'Referenced evidence was not provided', {
      missing,
    });
  }
  return selected;
}

export function distinctSources(evidence: readonly Evidence[]): ReadonlySet<SourceId> {
  return new Set(evidence.map((item) => item.sourceId));
}
