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
import { positiveMoneySchema } from '../money.js';
import {
  actorSchema,
  approvalRequestIdSchema,
  contributionIdSchema,
  entityRefSchema,
  isHuman,
  rewardIdSchema,
  sameActor,
  text,
  timestampSchema,
  uniqueList,
  type ContributionId,
  type RewardId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import { assertApprovalCovers, type ApprovalRequest } from './approval.js';

// ---------------------------------------------------------------- Contribution

export const CONTRIBUTION_KINDS = [
  'research',
  'evidence',
  'analysis',
  'build',
  'content',
  'sales',
  'operations',
  'other',
] as const;

export const CONTRIBUTION_STATUSES = ['recorded', 'verified', 'rejected'] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

export const contributionLifecycle = defineStateMachine<ContributionStatus>('contribution', {
  recorded: ['verified', 'rejected'],
  verified: [],
  rejected: [],
});

const newContributionShape = {
  /** A person or an AI agent; only people can later receive a Reward. */
  contributor: actorSchema,
  kind: z.enum(CONTRIBUTION_KINDS),
  description: text(2_000),
  subject: entityRefSchema.optional(),
  occurredAt: timestampSchema,
};

export const newContributionSchema = z.strictObject(newContributionShape);
export type NewContribution = z.infer<typeof newContributionSchema>;

export const contributionSchema = z.object({
  ...newContributionShape,
  id: contributionIdSchema,
  status: z.enum(CONTRIBUTION_STATUSES),
  review: z
    .strictObject({
      reviewedBy: actorSchema,
      reviewedAt: timestampSchema,
      note: text(1_000).optional(),
    })
    .optional(),
  ...mutableMetaShape,
});
export type Contribution = z.infer<typeof contributionSchema>;

export function createContribution(
  data: NewContribution,
  context: CreateContext<ContributionId>,
): Contribution {
  return parseEntity(contributionSchema, 'contribution', {
    ...data,
    id: context.id,
    status: 'recorded',
    ...mutableMeta(context),
  });
}

/** Verification step of the reward chain (§2.10). Owner only. */
export function reviewContribution(
  contribution: Contribution,
  review: { readonly verdict: 'verify' | 'reject'; readonly note?: string | undefined },
  context: DomainContext,
): Contribution {
  assertOwner(context.actor, 'verify contributions');
  return transition(
    contribution,
    contributionLifecycle,
    contributionSchema,
    review.verdict === 'verify' ? 'verified' : 'rejected',
    context,
    {
      review: {
        reviewedBy: context.actor,
        reviewedAt: context.at,
        ...(review.note === undefined ? {} : { note: review.note }),
      },
    },
  );
}

// ---------------------------------------------------------------- Reward

export const REWARD_STATUSES = ['calculated', 'approved', 'payable', 'paid', 'cancelled'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const rewardLifecycle = defineStateMachine<RewardStatus>('reward', {
  calculated: ['approved', 'cancelled'],
  approved: ['payable', 'cancelled'],
  payable: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
});

const newRewardShape = {
  contributor: actorSchema,
  contributionIds: uniqueList(contributionIdSchema, { min: 1, max: 100 }),
  amount: positiveMoneySchema,
  /** Which reward rule produced the amount (rules arrive in PHASE 17). */
  ruleId: text(100),
  note: text(1_000).optional(),
};

export const newRewardSchema = z.strictObject(newRewardShape);
export type NewReward = z.infer<typeof newRewardSchema>;

export const rewardSchema = z
  .object({
    ...newRewardShape,
    id: rewardIdSchema,
    status: z.enum(REWARD_STATUSES),
    approvalRequestId: approvalRequestIdSchema.optional(),
    payment: z.strictObject({ paidAt: timestampSchema, reference: text(200) }).optional(),
    ...mutableMetaShape,
  })
  .refine((reward) => isHuman(reward.contributor), {
    message: 'rewards are paid to people only',
    path: ['contributor'],
  })
  .refine(
    (reward) =>
      !['approved', 'payable', 'paid'].includes(reward.status) ||
      reward.approvalRequestId !== undefined,
    {
      message: 'an approved reward must reference its payout approval',
      path: ['approvalRequestId'],
    },
  )
  .refine((reward) => reward.status !== 'paid' || reward.payment !== undefined, {
    message: 'a paid reward must record the payment',
    path: ['payment'],
  });
export type Reward = z.infer<typeof rewardSchema>;

/**
 * Reward only from verified contribution (§2.10): every referenced contribution
 * must be provided, verified and made by the same person.
 */
export function calculateReward(
  data: NewReward,
  contributions: readonly Contribution[],
  context: CreateContext<RewardId>,
): Reward {
  const byId = new Map(contributions.map((contribution) => [contribution.id, contribution]));
  for (const id of data.contributionIds) {
    const contribution = byId.get(id);
    if (contribution === undefined) {
      throw new DomainError('invariant_violation', 'Referenced contribution was not provided', {
        contribution_id: id,
      });
    }
    if (contribution.status !== 'verified') {
      throw new DomainError('invariant_violation', 'Rewards require verified contributions', {
        contribution_id: id,
        contribution_status: contribution.status,
      });
    }
    if (!sameActor(contribution.contributor, data.contributor)) {
      throw new DomainError('invariant_violation', 'Contribution belongs to another contributor', {
        contribution_id: id,
      });
    }
  }
  return parseEntity(rewardSchema, 'reward', {
    ...data,
    id: context.id,
    status: 'calculated',
    ...mutableMeta(context),
  });
}

/** Payouts always need the owner's approval (D-006). */
export function approveReward(
  reward: Reward,
  approval: ApprovalRequest | undefined,
  context: DomainContext,
): Reward {
  assertOwner(context.actor, 'approve rewards');
  assertApprovalCovers(approval, {
    kind: 'payout',
    amount: reward.amount,
    subject: { type: 'reward', id: reward.id },
  });
  return transition(reward, rewardLifecycle, rewardSchema, 'approved', context, {
    ...(approval === undefined ? {} : { approvalRequestId: approval.id }),
  });
}

export function markRewardPayable(reward: Reward, context: DomainContext): Reward {
  return transition(reward, rewardLifecycle, rewardSchema, 'payable', context);
}

export function markRewardPaid(
  reward: Reward,
  payment: { readonly paidAt: Reward['createdAt']; readonly reference: string },
  context: DomainContext,
): Reward {
  return transition(reward, rewardLifecycle, rewardSchema, 'paid', context, { payment });
}

export function cancelReward(reward: Reward, context: DomainContext): Reward {
  return transition(reward, rewardLifecycle, rewardSchema, 'cancelled', context);
}
