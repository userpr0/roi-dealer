import { describe, expect, it } from 'vitest';
import {
  approvalRequestIdSchema,
  approveReward,
  calculateReward,
  cancelReward,
  contributionIdSchema,
  costEntryIdSchema,
  createApprovalRequest,
  createContribution,
  createKnowledgeAsset,
  knowledgeAssetIdSchema,
  markRewardPaid,
  markRewardPayable,
  recordCostEntry,
  resolveApprovalRequest,
  reviewContribution,
  rewardIdSchema,
  summarizeCosts,
  usd,
  type ApprovalKind,
  type Contribution,
  type Money,
  type NewCostEntry,
  type NewReward,
  type Reward,
} from '@roi-dealer/domain';
import { AGENT, at, createCtx, ctx, MEMBER, OWNER, SYSTEM } from '../../support/domain.js';

function approved(kind: ApprovalKind, amount: Money, subject?: { type: 'reward'; id: string }) {
  const request = createApprovalRequest(
    {
      kind,
      title: `Approve ${kind}`,
      summary: 'Details for the owner',
      amount,
      ...(subject === undefined ? {} : { subject }),
      expiresAt: at(600),
    },
    createCtx(approvalRequestIdSchema, SYSTEM, 1),
  );
  return resolveApprovalRequest(request, { decision: 'approve' }, ctx(OWNER, 2));
}

function cost(overrides: Partial<NewCostEntry> = {}): NewCostEntry {
  return {
    category: 'ai',
    amount: usd(1_500),
    description: 'Model usage for research',
    incurredAt: at(0),
    recurring: false,
    allocation: {},
    ...overrides,
  };
}

describe('CostEntry (D-006)', () => {
  it('records spend up to $20 without approval', () => {
    const entry = recordCostEntry(
      cost({ amount: usd(2_000) }),
      createCtx(costEntryIdSchema, SYSTEM),
    );
    expect(entry).toMatchObject({ amount: usd(2_000), createdBy: SYSTEM });
  });

  it('requires a covering approval above $20', () => {
    expect(() =>
      recordCostEntry(cost({ amount: usd(2_001) }), createCtx(costEntryIdSchema, SYSTEM)),
    ).toThrow(expect.objectContaining({ code: 'approval_required' }));

    const approval = approved('spend', usd(5_000));
    expect(() =>
      recordCostEntry(
        cost({ amount: usd(6_000), approvalRequestId: approval.id }),
        createCtx(costEntryIdSchema, SYSTEM),
        approval,
      ),
    ).toThrow(expect.objectContaining({ code: 'approval_required' }));

    const entry = recordCostEntry(
      cost({ amount: usd(5_000), approvalRequestId: approval.id }),
      createCtx(costEntryIdSchema, SYSTEM),
      approval,
    );
    expect(entry.approvalRequestId).toBe(approval.id);
  });

  it('always requires approval for recurring charges', () => {
    expect(() =>
      recordCostEntry(cost({ amount: usd(500), recurring: true }), createCtx(costEntryIdSchema)),
    ).toThrow(expect.objectContaining({ code: 'approval_required' }));

    const approval = approved('recurring_payment', usd(500));
    expect(
      recordCostEntry(
        cost({
          amount: usd(500),
          recurring: true,
          category: 'infrastructure',
          approvalRequestId: approval.id,
        }),
        createCtx(costEntryIdSchema),
        approval,
      ).recurring,
    ).toBe(true);
  });

  it('corrects entries with reversals and sums deterministically', () => {
    const ai = recordCostEntry(cost(), createCtx(costEntryIdSchema));
    const hosting = recordCostEntry(
      cost({ category: 'infrastructure', amount: usd(700) }),
      createCtx(costEntryIdSchema),
    );
    const reversal = recordCostEntry(
      cost({ amount: usd(1_500), reversalOf: ai.id, description: 'Duplicate charge' }),
      createCtx(costEntryIdSchema),
    );

    expect(summarizeCosts([ai, hosting, reversal])).toEqual({
      total: usd(700),
      byCategory: { ai: usd(0), infrastructure: usd(700) },
    });
  });

  it('rejects non-positive amounts', () => {
    expect(() => recordCostEntry(cost({ amount: usd(0) }), createCtx(costEntryIdSchema))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });
});

describe('Contribution → Reward chain (§2.10)', () => {
  function contribution(contributor = MEMBER): Contribution {
    return createContribution(
      {
        contributor,
        kind: 'research',
        description: 'Collected 40 pieces of evidence on invoice pain',
        occurredAt: at(0),
      },
      createCtx(contributionIdSchema, SYSTEM),
    );
  }
  const verify = (item: Contribution) =>
    reviewContribution(item, { verdict: 'verify' }, ctx(OWNER, 5));
  const rewardData = (items: Contribution[], contributor = MEMBER): NewReward => ({
    contributor,
    contributionIds: items.map((item) => item.id),
    amount: usd(10_000),
    ruleId: 'manual-v1',
  });

  it('verifies contributions by the owner only', () => {
    expect(() => reviewContribution(contribution(), { verdict: 'verify' }, ctx(AGENT))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
    expect(verify(contribution())).toMatchObject({
      status: 'verified',
      review: { reviewedBy: OWNER, reviewedAt: at(5) },
    });
    expect(
      reviewContribution(contribution(), { verdict: 'reject', note: 'duplicate' }, ctx(OWNER))
        .status,
    ).toBe('rejected');
  });

  it('calculates rewards only from verified contributions of the same person', () => {
    const unverified = contribution();
    expect(() =>
      calculateReward(rewardData([unverified]), [unverified], createCtx(rewardIdSchema)),
    ).toThrow(/verified contributions/);

    const someoneElse = verify(contribution({ type: 'member', id: 'member-2' }));
    expect(() =>
      calculateReward(rewardData([someoneElse]), [someoneElse], createCtx(rewardIdSchema)),
    ).toThrow(/another contributor/);

    const missing = verify(contribution());
    expect(() => calculateReward(rewardData([missing]), [], createCtx(rewardIdSchema))).toThrow(
      /was not provided/,
    );

    const agentWork = verify(contribution(AGENT));
    expect(() =>
      calculateReward(rewardData([agentWork], AGENT), [agentWork], createCtx(rewardIdSchema)),
    ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));

    const mine = verify(contribution());
    expect(calculateReward(rewardData([mine]), [mine], createCtx(rewardIdSchema)).status).toBe(
      'calculated',
    );
  });

  it('pays out only after an owner-approved payout for this reward', () => {
    const verified = verify(contribution());
    const reward: Reward = calculateReward(
      rewardData([verified]),
      [verified],
      createCtx(rewardIdSchema, SYSTEM),
    );

    expect(() => approveReward(reward, undefined, ctx(OWNER))).toThrow(
      expect.objectContaining({ code: 'approval_required' }),
    );
    expect(() => approveReward(reward, approved('payout', usd(10_000)), ctx(OWNER))).toThrow(
      /different subject/,
    );

    const payout = approved('payout', usd(10_000), { type: 'reward', id: reward.id });
    expect(() => approveReward(reward, payout, ctx(MEMBER))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );

    const approvedReward = approveReward(reward, payout, ctx(OWNER, 10));
    expect(approvedReward).toMatchObject({ status: 'approved', approvalRequestId: payout.id });

    const payable = markRewardPayable(approvedReward, ctx(SYSTEM, 11));
    const paid = markRewardPaid(
      payable,
      { paidAt: at(12), reference: 'wise-123' },
      ctx(SYSTEM, 12),
    );
    expect(paid).toMatchObject({ status: 'paid', payment: { reference: 'wise-123' } });
    expect(() => cancelReward(paid, ctx(OWNER))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    expect(cancelReward(payable, ctx(OWNER)).status).toBe('cancelled');
  });
});

describe('KnowledgeAsset (§2.9)', () => {
  it('normalizes tags and links the cycle that produced it', () => {
    const asset = createKnowledgeAsset(
      {
        kind: 'failure_pattern',
        title: 'Agencies do not pay for reconciliation alone',
        summary: 'Waitlist conversion 0.4% at $49/month',
        links: { evidenceIds: [] },
        tags: [' Pricing ', 'agencies'],
      },
      createCtx(knowledgeAssetIdSchema, AGENT),
    );
    expect(asset.tags).toEqual(['pricing', 'agencies']);
    expect(asset).not.toHaveProperty('version');
  });
});
