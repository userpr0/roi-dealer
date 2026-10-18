import { z } from 'zod';
import { immutableMeta, immutableMetaShape, parseEntity, type CreateContext } from '../entity.js';
import { DomainError } from '../errors.js';
import {
  countryCodeSchema,
  evidenceIdSchema,
  httpUrlSchema,
  languageTagSchema,
  sourceIdSchema,
  sourceSnapshotIdSchema,
  text,
  timestampMs,
  timestampSchema,
  type EvidenceId,
  type SourceId,
} from '../primitives.js';
import { containsContactData } from '../privacy.js';

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
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Id of an item at its source, e.g. a Hacker News item id; unique per source. */
export const externalIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

const newEvidenceShape = {
  sourceId: sourceIdSchema,
  kind: z.enum(EVIDENCE_KINDS),
  /** Excerpt or measured value, as observed, without contact data (D-014 п.6). */
  excerpt: text(5_000).refine((excerpt) => !containsContactData(excerpt), {
    message: 'excerpt must not contain an email address or phone number; redact it first',
  }),
  url: httpUrlSchema.optional(),
  observedAt: timestampSchema,
  market: countryCodeSchema.optional(),
  language: languageTagSchema.optional(),
  /** The load it was collected in (PHASE 05 provenance); absent for manual evidence. */
  snapshotId: sourceSnapshotIdSchema.optional(),
  externalId: externalIdSchema.optional(),
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
