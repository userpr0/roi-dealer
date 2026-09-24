import { z } from 'zod';

export const ENTITY_TYPES = [
  'source',
  'evidence',
  'signal',
  'pain',
  'opportunity',
  'decision',
  'approval_request',
  'hypothesis',
  'experiment',
  'cost_entry',
  'contribution',
  'reward',
  'knowledge_asset',
] as const;
export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof entityTypeSchema>;

// Branded UUID ids: an EvidenceId cannot be passed where a SourceId is expected.
export const sourceIdSchema = z.uuid().brand<'SourceId'>();
export type SourceId = z.infer<typeof sourceIdSchema>;
export const evidenceIdSchema = z.uuid().brand<'EvidenceId'>();
export type EvidenceId = z.infer<typeof evidenceIdSchema>;
export const signalIdSchema = z.uuid().brand<'SignalId'>();
export type SignalId = z.infer<typeof signalIdSchema>;
export const painIdSchema = z.uuid().brand<'PainId'>();
export type PainId = z.infer<typeof painIdSchema>;
export const opportunityIdSchema = z.uuid().brand<'OpportunityId'>();
export type OpportunityId = z.infer<typeof opportunityIdSchema>;
export const decisionIdSchema = z.uuid().brand<'DecisionId'>();
export type DecisionId = z.infer<typeof decisionIdSchema>;
export const approvalRequestIdSchema = z.uuid().brand<'ApprovalRequestId'>();
export type ApprovalRequestId = z.infer<typeof approvalRequestIdSchema>;
export const hypothesisIdSchema = z.uuid().brand<'HypothesisId'>();
export type HypothesisId = z.infer<typeof hypothesisIdSchema>;
export const experimentIdSchema = z.uuid().brand<'ExperimentId'>();
export type ExperimentId = z.infer<typeof experimentIdSchema>;
export const costEntryIdSchema = z.uuid().brand<'CostEntryId'>();
export type CostEntryId = z.infer<typeof costEntryIdSchema>;
export const contributionIdSchema = z.uuid().brand<'ContributionId'>();
export type ContributionId = z.infer<typeof contributionIdSchema>;
export const rewardIdSchema = z.uuid().brand<'RewardId'>();
export type RewardId = z.infer<typeof rewardIdSchema>;
export const knowledgeAssetIdSchema = z.uuid().brand<'KnowledgeAssetId'>();
export type KnowledgeAssetId = z.infer<typeof knowledgeAssetIdSchema>;

/** ISO-8601 instant in UTC (`…Z`). Offsets are rejected so all stored times are UTC. */
export const timestampSchema = z.iso.datetime().brand<'Timestamp'>();
export type Timestamp = z.infer<typeof timestampSchema>;

export function toTimestamp(date: Date): Timestamp {
  return timestampSchema.parse(date.toISOString());
}

/** Milliseconds since epoch; compare timestamps with this, never as strings. */
export function timestampMs(value: Timestamp): number {
  return Date.parse(value);
}

/** Trimmed, non-empty text with an upper length bound. */
export function text(max: number) {
  return z.string().trim().min(1).max(max);
}

export const titleSchema = text(200);

export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'expected an ISO 3166-1 alpha-2 country code');
export type CountryCode = z.infer<typeof countryCodeSchema>;

export const languageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'expected a BCP 47 language tag such as en or en-US');

export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2_000);

/** Array without duplicates (for id and code lists). */
export function uniqueList<T extends z.ZodType>(item: T, bounds: { min?: number; max: number }) {
  return z
    .array(item)
    .min(bounds.min ?? 0)
    .max(bounds.max)
    .refine((items) => new Set(items).size === items.length, 'items must be unique');
}

export const ACTOR_TYPES = ['owner', 'member', 'agent', 'system', 'integration'] as const;

/**
 * Who performs an action. `agent` is an AI agent: it may propose, never decide (§2.3).
 * `member` is a future team member (D-004); permissions arrive in PHASE 04.
 */
export const actorSchema = z.strictObject({
  type: z.enum(ACTOR_TYPES),
  id: z.string().trim().min(1).max(128),
});
export type Actor = z.infer<typeof actorSchema>;

export function isHuman(actor: Actor): boolean {
  return actor.type === 'owner' || actor.type === 'member';
}

export function sameActor(a: Actor, b: Actor): boolean {
  return a.type === b.type && a.id === b.id;
}

export const entityRefSchema = z.strictObject({ type: entityTypeSchema, id: z.uuid() });
export type EntityRef = z.infer<typeof entityRefSchema>;

export const metricSchema = z.strictObject({
  name: text(100),
  target: z.number(),
  unit: text(32),
  direction: z.enum(['at_least', 'at_most']),
});
export type Metric = z.infer<typeof metricSchema>;
