import type { Database } from '@roi-dealer/database';
import {
  approveMediaAsset,
  createMediaAsset,
  mediaAssetIdSchema,
  releaseMediaAsset,
  RELEASE_OWNER_CHECKS,
  toTimestamp,
  type Experiment,
  type MediaAsset,
  type Opportunity,
} from '@roi-dealer/domain';
import { checkLanding, landingSlug, newPreviewToken } from '@roi-dealer/media';
import { uuidv7 } from '@roi-dealer/shared';
import { OWNER, SYSTEM } from './domain.js';
import { perfectLandingAnswer } from './media-answers.js';

/*
 * A released landing of a test as PHASE 19a and 21 leave it, built through the domain for
 * tests of later phases.
 */

const now = () => toTimestamp(new Date());

/** A checked page for the test, approved and released by the owner. */
export async function releasedLanding(
  db: Database,
  opportunity: Opportunity,
  experiment: Experiment,
): Promise<MediaAsset> {
  const hypothesis = await db.repositories.hypotheses.getById(experiment.hypothesisId);
  if (hypothesis === undefined) throw new Error('no hypothesis');
  const material = {
    opportunity: {
      title: opportunity.title,
      icp: opportunity.icp,
      problem: opportunity.valueProposition.problem,
      change: opportunity.valueProposition.change,
      measurableResult: opportunity.valueProposition.measurableResult,
    },
    hypothesis: {
      audience: hypothesis.audience,
      offer: hypothesis.offer,
      priceUsd: hypothesis.price.amountCents / 100,
      channel: hypothesis.channel,
      creative: hypothesis.creative,
      cta: hypothesis.cta,
      method: hypothesis.validationMethod,
    },
    rejectedHeadline: '',
    feedback: '',
  };
  const checked = checkLanding(material, perfectLandingAnswer(material));
  if (!('content' in checked)) throw new Error(checked.issues.join('; '));
  const id = mediaAssetIdSchema.parse(uuidv7());
  const draft = createMediaAsset(
    {
      kind: 'landing',
      experimentId: experiment.id,
      hypothesisId: experiment.hypothesisId,
      opportunityId: experiment.opportunityId,
      content: checked.content,
      slug: landingSlug(opportunity.title, id),
      previewToken: newPreviewToken(),
    },
    { id, actor: SYSTEM, at: now() },
  );
  await db.repositories.mediaAssets.insert(draft);
  const approved = approveMediaAsset(draft, { actor: OWNER, at: now() });
  await db.repositories.mediaAssets.update(approved, OWNER);
  const released = releaseMediaAsset(
    approved,
    {
      asset: approved,
      experiment,
      hypothesis,
      trackerActive: true,
      pageStatic: true,
      checkoutReady: true,
    },
    RELEASE_OWNER_CHECKS,
    { actor: OWNER, at: now() },
  );
  await db.repositories.mediaAssets.update(released, OWNER);
  return released;
}
