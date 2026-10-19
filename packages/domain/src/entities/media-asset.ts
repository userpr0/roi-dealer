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
import { nonNegativeMoneySchema } from '../money.js';
import {
  experimentIdSchema,
  hypothesisIdSchema,
  mediaAssetIdSchema,
  opportunityIdSchema,
  text,
  type MediaAssetId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/*
 * Media Factory (PHASE 19a, D-022): a creative a test needs — for now the landing page of a
 * test and its ad texts. An agent writes the draft; only the owner approves or rejects it
 * (§2.3). Prices and the honesty note come from code (§2.13, §2.17), not from the model.
 */

export const MEDIA_ASSET_KINDS = ['landing'] as const;

export const MEDIA_ASSET_STATUSES = [
  'draft',
  'approved',
  'rejected',
  'released',
  'retired',
] as const;
export type MediaAssetStatus = (typeof MEDIA_ASSET_STATUSES)[number];

/** A draft is approved or rejected by the owner; an approved one is released (PHASE 21). */
export const mediaAssetLifecycle = defineStateMachine<MediaAssetStatus>('media_asset', {
  draft: ['approved', 'rejected'],
  approved: ['released', 'retired'],
  released: ['retired'],
  rejected: [],
  retired: [],
});

/** After the owner's ❌ a landing is written again, at most this many times per experiment. */
export const MAX_LANDING_REWRITES = 2;

/** Draft, approved and released assets are live: one per experiment (index in 0015). */
export const LIVE_MEDIA_STATUSES = ['draft', 'approved', 'released'] as const;

export const PRICE_PERIODS = ['one_time', 'per_month', 'per_year', 'per_user_month'] as const;
export type PricePeriod = (typeof PRICE_PERIODS)[number];

/**
 * The honesty note of the page (D-014 п.8): a product in development asks for an email; a
 * preorder takes money in advance with a full refund if the product is not delivered.
 */
export const LANDING_DISCLOSURES = ['in_development', 'preorder'] as const;
export type LandingDisclosure = (typeof LANDING_DISCLOSURES)[number];

/** Character limits of every part of the page. */
export const LANDING_LIMITS = {
  headline: 90,
  subheadline: 200,
  problem: 300,
  benefitTitle: 60,
  benefitText: 160,
  step: 140,
  offer: 200,
  cta: 40,
  question: 120,
  answer: 300,
  adHeadline: 60,
  adBody: 150,
} as const;

export const LANDING_PARTS = { benefits: 3, steps: 3, minFaq: 2, maxFaq: 4, ads: 3 } as const;

export const landingContentSchema = z.strictObject({
  headline: text(LANDING_LIMITS.headline),
  subheadline: text(LANDING_LIMITS.subheadline),
  problem: text(LANDING_LIMITS.problem),
  benefits: z
    .array(
      z.strictObject({
        title: text(LANDING_LIMITS.benefitTitle),
        text: text(LANDING_LIMITS.benefitText),
      }),
    )
    .length(LANDING_PARTS.benefits),
  steps: z.array(text(LANDING_LIMITS.step)).length(LANDING_PARTS.steps),
  offer: text(LANDING_LIMITS.offer),
  /** From the hypothesis, never from the model. */
  price: nonNegativeMoneySchema,
  pricePeriod: z.enum(PRICE_PERIODS),
  cta: text(LANDING_LIMITS.cta),
  faq: z
    .array(
      z.strictObject({
        question: text(LANDING_LIMITS.question),
        answer: text(LANDING_LIMITS.answer),
      }),
    )
    .min(LANDING_PARTS.minFaq)
    .max(LANDING_PARTS.maxFaq),
  ads: z
    .array(
      z.strictObject({
        headline: text(LANDING_LIMITS.adHeadline),
        body: text(LANDING_LIMITS.adBody),
      }),
    )
    .length(LANDING_PARTS.ads),
  /** Set by code from the validation method. */
  disclosure: z.enum(LANDING_DISCLOSURES),
});
export type LandingContent = z.infer<typeof landingContentSchema>;

/** The public path segment, e.g. `invoices-that-get-paid-3f9a`. */
export const MEDIA_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
/** An unguessable token (at least 128 bits, base64url) for the private preview. */
export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

const newMediaAssetShape = {
  kind: z.enum(MEDIA_ASSET_KINDS),
  experimentId: experimentIdSchema,
  hypothesisId: hypothesisIdSchema,
  opportunityId: opportunityIdSchema,
  content: landingContentSchema,
  slug: z.string().regex(MEDIA_SLUG_PATTERN),
  previewToken: z.string().regex(PREVIEW_TOKEN_PATTERN),
};

export const newMediaAssetSchema = z.strictObject(newMediaAssetShape);
export type NewMediaAsset = z.infer<typeof newMediaAssetSchema>;

export const mediaAssetSchema = z.object({
  ...newMediaAssetShape,
  id: mediaAssetIdSchema,
  status: z.enum(MEDIA_ASSET_STATUSES),
  ...mutableMetaShape,
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

/** A draft written by an agent or the system (PHASE 19a). */
export function createMediaAsset(
  data: NewMediaAsset,
  context: CreateContext<MediaAssetId>,
): MediaAsset {
  return parseEntity(mediaAssetSchema, 'media_asset', {
    ...data,
    id: context.id,
    status: 'draft',
    ...mutableMeta(context),
  });
}

/** Creative QA (D-012): the owner approves the draft. */
export function approveMediaAsset(asset: MediaAsset, context: DomainContext): MediaAsset {
  assertOwner(context.actor, 'approve media');
  return transition(asset, mediaAssetLifecycle, mediaAssetSchema, 'approved', context);
}

/** Creative QA: the owner rejects the draft; the agent may write it again. */
export function rejectMediaAsset(asset: MediaAsset, context: DomainContext): MediaAsset {
  assertOwner(context.actor, 'reject media');
  return transition(asset, mediaAssetLifecycle, mediaAssetSchema, 'rejected', context);
}

export function isLiveMediaAsset(asset: Pick<MediaAsset, 'status'>): boolean {
  return (LIVE_MEDIA_STATUSES as readonly string[]).includes(asset.status);
}
