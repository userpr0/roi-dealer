import { z } from 'zod';
import { immutableMeta, immutableMetaShape, parseEntity, type CreateContext } from '../entity.js';
import {
  evidenceIdSchema,
  experimentIdSchema,
  hypothesisIdSchema,
  knowledgeAssetIdSchema,
  opportunityIdSchema,
  text,
  titleSchema,
  uniqueList,
  type KnowledgeAssetId,
} from '../primitives.js';

/** What a cycle can leave behind (§2.9). */
export const KNOWLEDGE_KINDS = [
  'evidence_summary',
  'knowledge',
  'pattern',
  'failure_pattern',
  'skill',
  'asset',
  'reusable_code',
  'market_data',
] as const;

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'expected a short lowercase tag');

const newKnowledgeAssetShape = {
  kind: z.enum(KNOWLEDGE_KINDS),
  title: titleSchema,
  summary: text(3_000),
  body: text(50_000).optional(),
  links: z.strictObject({
    evidenceIds: uniqueList(evidenceIdSchema, { max: 200 }),
    opportunityId: opportunityIdSchema.optional(),
    hypothesisId: hypothesisIdSchema.optional(),
    experimentId: experimentIdSchema.optional(),
  }),
  tags: uniqueList(tagSchema, { max: 20 }),
  /** A newer version of an asset references the one it replaces. */
  supersedes: knowledgeAssetIdSchema.optional(),
};

/** An immutable entry of the Company Brain. */
export const newKnowledgeAssetSchema = z.strictObject(newKnowledgeAssetShape);
export type NewKnowledgeAsset = z.infer<typeof newKnowledgeAssetSchema>;

export const knowledgeAssetSchema = z.object({
  ...newKnowledgeAssetShape,
  id: knowledgeAssetIdSchema,
  ...immutableMetaShape,
});
export type KnowledgeAsset = z.infer<typeof knowledgeAssetSchema>;

export function createKnowledgeAsset(
  data: NewKnowledgeAsset,
  context: CreateContext<KnowledgeAssetId>,
): KnowledgeAsset {
  return parseEntity(knowledgeAssetSchema, 'knowledge_asset', {
    ...data,
    id: context.id,
    ...immutableMeta(context),
  });
}
