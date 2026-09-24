import { describe, expect, it } from 'vitest';
import {
  approvalRequestIdSchema,
  assertApprovalCovers,
  cancelApprovalRequest,
  createApprovalRequest,
  DEFAULT_APPROVAL_POLICY,
  expireApprovalRequest,
  requiresOwnerApproval,
  resolveApprovalRequest,
  rewardIdSchema,
  usd,
  type ApprovalRequest,
  type ApprovalRequirement,
  type NewApprovalRequest,
} from '@roi-dealer/domain';
import { AGENT, at, createCtx, ctx, MEMBER, OWNER, SYSTEM } from '../../support/domain.js';

const rewardId = rewardIdSchema.parse('0190c5a6-7b8e-7c3d-9f00-123456789abc');

function request(overrides: Partial<NewApprovalRequest> = {}): ApprovalRequest {
  return createApprovalRequest(
    {
      kind: 'spend',
      title: 'Buy a domain name',
      summary: 'Domain for the landing page test',
      amount: usd(3_500),
      expiresAt: at(60),
      ...overrides,
    },
    createCtx(approvalRequestIdSchema, SYSTEM, 0),
  );
}

describe('requiresOwnerApproval (D-006)', () => {
  it('lets spend up to $20 through and gates anything above', () => {
    expect(DEFAULT_APPROVAL_POLICY.spendThreshold).toEqual(usd(2_000));
    expect(requiresOwnerApproval({ kind: 'spend', amount: usd(2_000) })).toBe(false);
    expect(requiresOwnerApproval({ kind: 'spend', amount: usd(2_001) })).toBe(true);
    expect(requiresOwnerApproval({ kind: 'spend' })).toBe(true);
  });

  it.each([
    'recurring_payment',
    'payout',
    'asset_purchase',
    'experiment_launch',
    'production_change',
    'legal',
    'secret_access',
    'policy_change',
    'budget_change',
  ] as const)('always gates %s, even for $1', (kind) => {
    expect(requiresOwnerApproval({ kind, amount: usd(100) })).toBe(true);
  });

  it('accepts a custom threshold', () => {
    expect(
      requiresOwnerApproval({ kind: 'spend', amount: usd(4_000) }, { spendThreshold: usd(5_000) }),
    ).toBe(false);
  });
});

describe('ApprovalRequest', () => {
  it('requires an amount for money-related kinds and a future expiry', () => {
    const { amount: _omit, ...withoutAmount } = {
      kind: 'payout' as const,
      title: 'Pay reward',
      summary: 'Reward for research',
      amount: usd(1),
      expiresAt: at(60),
    };
    expect(() => createApprovalRequest(withoutAmount, createCtx(approvalRequestIdSchema))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
    expect(() => request({ expiresAt: at(0) })).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
    expect(request({ kind: 'legal', amount: undefined }).status).toBe('pending');
  });

  it('is approved or rejected by the owner with a resolution record', () => {
    const pending = request();

    const approved = resolveApprovalRequest(
      pending,
      { decision: 'approve', comment: 'ok' },
      ctx(OWNER, 5),
    );

    expect(approved).toMatchObject({
      status: 'approved',
      resolution: { decidedBy: OWNER, decidedAt: at(5), comment: 'ok' },
    });
    expect(resolveApprovalRequest(pending, { decision: 'reject' }, ctx(OWNER, 5)).status).toBe(
      'rejected',
    );
    expect(() => resolveApprovalRequest(approved, { decision: 'reject' }, ctx(OWNER, 6))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it.each([AGENT, MEMBER, SYSTEM])('cannot be resolved by $type actors', (actor) => {
    expect(() => resolveApprovalRequest(request(), { decision: 'approve' }, ctx(actor, 5))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
  });

  it('cannot be approved after it expired, and expires only after expiresAt', () => {
    const pending = request({ expiresAt: at(30) });

    expect(() => resolveApprovalRequest(pending, { decision: 'approve' }, ctx(OWNER, 30))).toThrow(
      expect.objectContaining({ code: 'approval_expired' }),
    );
    expect(() => expireApprovalRequest(pending, ctx(SYSTEM, 29))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
    expect(expireApprovalRequest(pending, ctx(SYSTEM, 30)).status).toBe('expired');
    expect(cancelApprovalRequest(pending, ctx(SYSTEM, 1)).status).toBe('cancelled');
  });
});

describe('assertApprovalCovers', () => {
  const payout = () =>
    resolveApprovalRequest(
      request({
        kind: 'payout',
        title: 'Reward payout',
        amount: usd(10_000),
        subject: { type: 'reward', id: rewardId },
      }),
      { decision: 'approve' },
      ctx(OWNER, 1),
    );
  const requirement = {
    kind: 'payout' as const,
    amount: usd(10_000),
    subject: { type: 'reward' as const, id: rewardId },
  };

  it('accepts an approved request that matches kind, amount, subject and id', () => {
    const approval = payout();
    expect(() => assertApprovalCovers(approval, { ...requirement, id: approval.id })).not.toThrow();
  });

  const cases: [string, () => ApprovalRequest | undefined, ApprovalRequirement][] = [
    ['missing', () => undefined, requirement],
    ['still pending', () => request({ kind: 'payout', amount: usd(10_000) }), requirement],
    ['another kind', payout, { ...requirement, kind: 'spend' as const }],
    ['lower amount', payout, { ...requirement, amount: usd(10_001) }],
    [
      'another subject',
      payout,
      {
        ...requirement,
        subject: { type: 'reward' as const, id: rewardIdSchema.parse(crypto.randomUUID()) },
      },
    ],
    [
      'another id',
      payout,
      { ...requirement, id: approvalRequestIdSchema.parse(crypto.randomUUID()) },
    ],
  ];

  it.each(cases)('rejects when the approval is %s', (_case, approval, required) => {
    expect(() => assertApprovalCovers(approval(), required)).toThrow(
      expect.objectContaining({ code: 'approval_required' }),
    );
  });
});
