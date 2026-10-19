import { describe, expect, it } from 'vitest';
import {
  memberActor,
  parseContribution,
  parsePaid,
  parseRewardCommand,
} from '@roi-dealer/command-center';
import {
  approvalRequestIdSchema,
  approveReward,
  calculateReward,
  contributionIdSchema,
  costEntryIdSchema,
  createApprovalRequest,
  createContribution,
  experimentIdSchema,
  markRewardPayable,
  recordRewardPayout,
  resolveApprovalRequest,
  reviewContribution,
  rewardIdSchema,
  usd,
  ZERO_USD,
  type Actor,
  type Contribution,
  type MoneyFlow,
} from '@roi-dealer/domain';
import { planReward, REWARD_RULES, shareBase } from '@roi-dealer/rewards';
import { AGENT, at, createCtx, ctx, OWNER } from '../../support/domain.js';

const ANNA = memberActor('anna');
const BOB = memberActor('bob');
const TEST = experimentIdSchema.parse('0190f4c2-0000-7000-8000-000000000001');
const OTHER_TEST = experimentIdSchema.parse('0190f4c2-0000-7000-8000-000000000002');

function contribution(
  contributor: Actor = ANNA,
  options: { readonly verified?: boolean; readonly test?: typeof TEST } = {},
): Contribution {
  const recorded = createContribution(
    {
      contributor,
      kind: 'sales',
      description: 'Brought two customers',
      occurredAt: at(1),
      ...(options.test === undefined ? {} : { subject: { type: 'experiment', id: options.test } }),
    },
    createCtx(contributionIdSchema, OWNER, 1),
  );
  return options.verified === false
    ? recorded
    : reviewContribution(recorded, { verdict: 'verify' }, ctx(OWNER, 2));
}

const flow = (paymentsCents: number, refundsCents = 0, preordersCents = 0): MoneyFlow => ({
  spend: ZERO_USD,
  payments: usd(paymentsCents),
  preorders: usd(preordersCents),
  refunds: usd(refundsCents),
  customers: 3,
});

describe('reward rules (PHASE 17, §2.10, §2.13)', () => {
  it('a fixed reward pays the amount the owner set for verified contributions', () => {
    const first = contribution();
    const second = contribution();
    const plan = planReward({
      contributions: [first, second],
      rewarded: new Set(),
      terms: { rule: 'fixed', amount: usd(5_000) },
    });
    expect(plan).toEqual({
      ok: true,
      reward: {
        contributor: ANNA,
        contributionIds: [first.id, second.id],
        amount: usd(5_000),
        ruleId: REWARD_RULES.fixed,
      },
    });
  });

  it('a revenue share takes the percent of the test’s net confirmed revenue, rounded down', () => {
    const plan = planReward({
      contributions: [contribution(ANNA, { test: TEST })],
      rewarded: new Set(),
      terms: { rule: 'revenue_share', percent: 12.5 },
      // $120.03 paid, $20 refunded; a preorder of $50 may still be returned.
      revenue: flow(12_003, 2_000, 5_000),
    });
    expect(plan).toMatchObject({
      ok: true,
      base: usd(10_003),
      reward: { amount: usd(1_250), ruleId: REWARD_RULES.revenue_share },
    });
    expect(shareBase(flow(1_000, 3_000))).toEqual(usd(0));
    expect(shareBase(undefined)).toEqual(usd(0));
  });

  it('refuses what §2.10 does not allow, naming the contribution', () => {
    const fixed = { rule: 'fixed', amount: usd(1_000) } as const;
    const verified = contribution();
    const refusal = (input: Parameters<typeof planReward>[0]) => {
      const plan = planReward(input);
      return plan.ok ? undefined : [plan.reason, plan.contributionId];
    };
    expect(refusal({ contributions: [], rewarded: new Set(), terms: fixed })).toEqual([
      'empty',
      undefined,
    ]);
    for (const person of [OWNER, AGENT]) {
      expect(
        refusal({ contributions: [contribution(person)], rewarded: new Set(), terms: fixed }),
      ).toEqual(['not_a_member', undefined]);
    }
    const unverified = contribution(ANNA, { verified: false });
    expect(
      refusal({ contributions: [verified, unverified], rewarded: new Set(), terms: fixed }),
    ).toEqual(['not_verified', unverified.id]);
    const bobs = contribution(BOB);
    expect(refusal({ contributions: [verified, bobs], rewarded: new Set(), terms: fixed })).toEqual(
      ['other_contributor', bobs.id],
    );
    expect(
      refusal({ contributions: [verified], rewarded: new Set([verified.id]), terms: fixed }),
    ).toEqual(['already_rewarded', verified.id]);
    for (const amount of [0, 1_000_001]) {
      expect(
        refusal({
          contributions: [verified],
          rewarded: new Set(),
          terms: { rule: 'fixed', amount: { currency: 'USD', amountCents: amount } },
        }),
      ).toEqual(['bad_amount', undefined]);
    }
  });

  it('a revenue share needs one test with revenue and a percent up to 50', () => {
    const share = (percent: number) => ({ rule: 'revenue_share', percent }) as const;
    const reason = (input: Parameters<typeof planReward>[0]) => {
      const plan = planReward(input);
      return plan.ok ? 'ok' : plan.reason;
    };
    const onTest = contribution(ANNA, { test: TEST });
    expect(
      reason({
        contributions: [onTest],
        rewarded: new Set(),
        terms: share(51),
        revenue: flow(100),
      }),
    ).toBe('bad_percent');
    expect(
      reason({ contributions: [onTest], rewarded: new Set(), terms: share(0), revenue: flow(100) }),
    ).toBe('bad_percent');
    expect(reason({ contributions: [contribution()], rewarded: new Set(), terms: share(10) })).toBe(
      'no_test',
    );
    expect(
      reason({
        contributions: [onTest, contribution(ANNA, { test: OTHER_TEST })],
        rewarded: new Set(),
        terms: share(10),
      }),
    ).toBe('different_tests');
    expect(
      reason({ contributions: [onTest], rewarded: new Set(), terms: share(10), revenue: flow(0) }),
    ).toBe('no_revenue');
    // 10 % of 5 cents is less than a cent: nothing to pay.
    expect(
      reason({ contributions: [onTest], rewarded: new Set(), terms: share(10), revenue: flow(5) }),
    ).toBe('no_revenue');
  });
});

describe('recording a payout (PHASE 17, D-006)', () => {
  function payableReward() {
    const verified = contribution();
    const reward = calculateReward(
      { contributor: ANNA, contributionIds: [verified.id], amount: usd(5_000), ruleId: 'fixed-v1' },
      [verified],
      createCtx(rewardIdSchema, OWNER, 3),
    );
    const request = resolveApprovalRequest(
      createApprovalRequest(
        {
          kind: 'payout',
          title: 'Payout',
          summary: 'Anna',
          amount: usd(5_000),
          subject: { type: 'reward', id: reward.id },
          expiresAt: at(10_000),
        },
        createCtx(approvalRequestIdSchema, OWNER, 4),
      ),
      { decision: 'approve' },
      ctx(OWNER, 5),
    );
    const approved = approveReward(reward, request, ctx(OWNER, 6));
    return { reward: markRewardPayable(approved, ctx(OWNER, 7)), request };
  }

  it('marks the reward paid and records a cost of the month covered by the payout approval', () => {
    const { reward, request } = payableReward();
    const { reward: paid, cost } = recordRewardPayout(
      reward,
      { paidAt: at(8), reference: 'PayPal 5XY12345' },
      request,
      createCtx(costEntryIdSchema, OWNER, 8),
    );
    expect(paid).toMatchObject({
      status: 'paid',
      payment: { paidAt: at(8), reference: 'PayPal 5XY12345' },
    });
    expect(cost).toMatchObject({
      category: 'human',
      amount: usd(5_000),
      approvalRequestId: request.id,
      allocation: {},
      recurring: false,
    });
  });

  it('only the owner records it, only for a payable reward, only with its approval', () => {
    const { reward, request } = payableReward();
    const payment = { paidAt: at(8), reference: 'PayPal 5XY12345' };
    expect(() =>
      recordRewardPayout(reward, payment, request, createCtx(costEntryIdSchema, AGENT, 8)),
    ).toThrow(/owner/i);
    expect(() =>
      recordRewardPayout(reward, payment, undefined, createCtx(costEntryIdSchema, OWNER, 8)),
    ).toThrow(/approval/i);
    const { reward: paid } = recordRewardPayout(
      reward,
      payment,
      request,
      createCtx(costEntryIdSchema, OWNER, 8),
    );
    expect(() =>
      recordRewardPayout(paid, payment, request, createCtx(costEntryIdSchema, OWNER, 9)),
    ).toThrow();
  });
});

describe('reward commands (PHASE 17)', () => {
  it('/contribution reads who, the kind, an optional test and what was done', () => {
    expect(parseContribution('@Anna продажи тест 1 Привела двух клиентов')).toEqual({
      handle: 'anna',
      kind: 'sales',
      test: 1,
      description: 'Привела двух клиентов',
    });
    expect(parseContribution('ivan-k build Landing for test two')).toEqual({
      handle: 'ivan-k',
      kind: 'build',
      description: 'Landing for test two',
    });
    expect(parseContribution('')).toContain('Формат: /contribution');
    expect(parseContribution('Анна продажи Привела')).toContain('латиницей');
    expect(parseContribution('anna танцы Привела')).toContain('Неизвестный вид');
    expect(parseContribution('anna продажи тест x Привела')).toContain('Номер теста');
    expect(parseContribution('anna продажи')).toContain('Формат');
    expect(parseContribution('anna продажи ok')).toContain('Опишите');
  });

  it('/reward reads contribution numbers and a sum or a share', () => {
    expect(parseRewardCommand('3 $50')).toEqual({
      numbers: [3],
      terms: { rule: 'fixed', amount: usd(5_000) },
    });
    expect(parseRewardCommand('3,4 12.5%')).toEqual({
      numbers: [3, 4],
      terms: { rule: 'revenue_share', percent: 12.5 },
    });
    expect(parseRewardCommand('№3 4 49,99')).toEqual({
      numbers: [3, 4],
      terms: { rule: 'fixed', amount: usd(4_999) },
    });
    for (const bad of ['', '3', '3,3 $5', 'x $5', '3 five', '3 150%']) {
      expect(parseRewardCommand(bad)).toContain('Формат: /reward');
    }
  });

  it('/paid reads the reward number and the transfer reference', () => {
    expect(parsePaid('2 PayPal 5XY12345')).toEqual({ number: 2, reference: 'PayPal 5XY12345' });
    expect(parsePaid('2')).toContain('ссылку');
    expect(parsePaid('x PayPal')).toContain('Формат: /paid');
  });
});
