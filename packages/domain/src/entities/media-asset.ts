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
import { nonNegativeMoneySchema } from '../money.js';
import { readFunnelMeasure } from '../funnel.js';
import {
  experimentIdSchema,
  hypothesisIdSchema,
  mediaAssetIdSchema,
  opportunityIdSchema,
  text,
  timestampSchema,
  uniqueList,
  type MediaAssetId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import type { Experiment } from './experiment.js';
import type { Hypothesis } from './hypothesis.js';

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

/**
 * What the owner confirms at the Release Gate (PHASE 21, §7.2): the Early User Crash Test and
 * no known blocking defects. Everything else the gate checks in code (`releaseGate`).
 */
export const RELEASE_OWNER_CHECKS = ['crash_test', 'no_blockers'] as const;
export type ReleaseOwnerCheck = (typeof RELEASE_OWNER_CHECKS)[number];

export const mediaAssetSchema = z
  .object({
    ...newMediaAssetShape,
    id: mediaAssetIdSchema,
    status: z.enum(MEDIA_ASSET_STATUSES),
    /** What the owner confirmed at the Release Gate (PHASE 21); empty until the release. */
    releaseChecks: uniqueList(z.enum(RELEASE_OWNER_CHECKS), { max: RELEASE_OWNER_CHECKS.length }),
    releasedAt: timestampSchema.optional(),
    ...mutableMetaShape,
  })
  .refine((asset) => (asset.releasedAt === undefined) === (asset.releaseChecks.length === 0), {
    message: 'a release needs its time and the confirmed checks',
    path: ['releasedAt'],
  })
  .refine((asset) => asset.status !== 'released' || asset.releasedAt !== undefined, {
    message: 'a released asset needs its release time',
    path: ['releasedAt'],
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
    releaseChecks: [],
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

/** The checks of the Release Gate made by code (PHASE 21, playbook §7.2). */
export const RELEASE_CODE_CHECKS = [
  /** The owner approved the page (creative QA, 19a). */
  'page_approved',
  /** The owner approved the launch: budget, stop-loss and AI caps are fixed (§7.2, D-007). */
  'launch_approved',
  /** The success metric is a funnel measure and the stop-loss is set before the launch. */
  'metric_fixed',
  /** The honest-test checklist is confirmed, with the value described as a result (§2.17). */
  'honest_checks',
  /** The page tracker (integration `site`) is active: analytics work. */
  'tracking',
  /** The public page has no scripts and no external resources: nothing secret on the client. */
  'page_static',
  /** A paid preorder needs a tested checkout (PHASE 20b). */
  'payment_flow',
  /** A preorder page states the full refund. */
  'refund_terms',
] as const;
export type ReleaseCodeCheck = (typeof RELEASE_CODE_CHECKS)[number];

/** Experiments whose landing may be public: the launch is approved or the test runs. */
export const RELEASABLE_EXPERIMENT_STATUSES = ['approved', 'running'] as const;

/** The facts the gate is computed from; the caller loads them from the database. */
export interface ReleaseFacts {
  readonly asset: Pick<MediaAsset, 'status' | 'content'>;
  readonly experiment: Pick<
    Experiment,
    'status' | 'successMetric' | 'stopLoss' | 'checksConfirmedAt'
  >;
  readonly hypothesis: Pick<Hypothesis, 'validationMethod' | 'price'>;
  /** The page tracker's principal is active. */
  readonly trackerActive: boolean;
  /** The rendered public page has no scripts and no external addresses. */
  readonly pageStatic: boolean;
  /** A checkout of this test passed its test payment (PHASE 20b). */
  readonly checkoutReady: boolean;
}

export interface ReleaseGateItem {
  readonly check: ReleaseCodeCheck;
  readonly passed: boolean;
}

/** The applicable checks of the Release Gate and whether each passed, in order (§7.2). */
export function releaseGate(facts: ReleaseFacts): ReleaseGateItem[] {
  const { asset, experiment, hypothesis } = facts;
  const preorder = hypothesis.validationMethod === 'preorder';
  const paid = preorder && hypothesis.price.amountCents > 0;
  const results: Readonly<Record<ReleaseCodeCheck, boolean | undefined>> = {
    page_approved: asset.status === 'approved' || asset.status === 'released',
    launch_approved: (RELEASABLE_EXPERIMENT_STATUSES as readonly string[]).includes(
      experiment.status,
    ),
    metric_fixed:
      readFunnelMeasure(experiment.successMetric) !== undefined &&
      experiment.stopLoss.amountCents > 0,
    honest_checks: experiment.checksConfirmedAt !== undefined,
    tracking: facts.trackerActive,
    page_static: facts.pageStatic,
    payment_flow: paid ? facts.checkoutReady : undefined,
    refund_terms: preorder ? asset.content.disclosure === 'preorder' : undefined,
  };
  return RELEASE_CODE_CHECKS.flatMap((check) => {
    const passed = results[check];
    return passed === undefined ? [] : [{ check, passed }];
  });
}

/**
 * The release (PHASE 21): the owner publishes an approved page after every check of the gate
 * passed and the owner confirmed the crash test and the absence of known blockers.
 */
export function releaseMediaAsset(
  asset: MediaAsset,
  facts: ReleaseFacts,
  confirmed: readonly ReleaseOwnerCheck[],
  context: DomainContext,
): MediaAsset {
  assertOwner(context.actor, 'release media');
  const failed = releaseGate({ ...facts, asset }).filter((item) => !item.passed);
  if (failed.length > 0) {
    throw new DomainError('invariant_violation', 'The release gate has failed checks', {
      checks: failed.map((item) => item.check).join(','),
    });
  }
  const missing = RELEASE_OWNER_CHECKS.filter((check) => !confirmed.includes(check));
  if (missing.length > 0) {
    throw new DomainError('invariant_violation', 'The owner has not confirmed every check', {
      checks: missing.join(','),
    });
  }
  return transition(asset, mediaAssetLifecycle, mediaAssetSchema, 'released', context, {
    releaseChecks: [...RELEASE_OWNER_CHECKS],
    releasedAt: context.at,
  });
}
