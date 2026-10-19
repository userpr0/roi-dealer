import {
  sameActor,
  usd,
  type Contribution,
  type ContributionId,
  type ExperimentId,
  type Money,
  type MoneyFlow,
  type NewReward,
} from '@roi-dealer/domain';

/*
 * Reward rules (PHASE 17, §2.10, §2.13): the owner sets the terms and approves every payout
 * (D-006); the code checks the contributions and computes the amount. Nothing here pays.
 */

/** The rules a reward is calculated by; the id is stored with the reward. */
export const REWARD_RULES = {
  fixed: 'fixed-v1',
  revenue_share: 'revenue-share-v1',
} as const;
export type RewardRule = keyof typeof REWARD_RULES;

/** The most one fixed reward may be: $10,000. */
export const MAX_FIXED_REWARD: Money = usd(1_000_000);
/** The largest share of a test's net revenue one reward may take. */
export const MAX_REVENUE_SHARE_PERCENT = 50;

export type RewardTerms =
  | { readonly rule: 'fixed'; readonly amount: Money }
  | { readonly rule: 'revenue_share'; readonly percent: number };

export type RewardRefusal =
  /** No contributions were given. */
  | 'empty'
  /** Rewards go to team members only: not the owner, not an AI agent (§2.10). */
  | 'not_a_member'
  | 'not_verified'
  | 'other_contributor'
  | 'already_rewarded'
  /** The fixed amount is zero or above `MAX_FIXED_REWARD`. */
  | 'bad_amount'
  /** The share is not within 0–`MAX_REVENUE_SHARE_PERCENT` %. */
  | 'bad_percent'
  /** A revenue share needs every contribution linked to one test. */
  | 'no_test'
  | 'different_tests'
  /** The test has no confirmed net revenue (payments minus refunds) to share. */
  | 'no_revenue';

export interface RewardPlanInput {
  /** The contributions to reward, all of one person. */
  readonly contributions: readonly Contribution[];
  /** Contributions already in a reward that is not cancelled. */
  readonly rewarded: ReadonlySet<ContributionId>;
  readonly terms: RewardTerms;
  /** The money of the contributions' test, for a revenue share. */
  readonly revenue?: MoneyFlow | undefined;
}

export type RewardPlan =
  | {
      readonly ok: true;
      readonly reward: NewReward;
      /** The test's net confirmed revenue a share was taken from. */
      readonly base?: Money | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: RewardRefusal;
      readonly contributionId?: ContributionId | undefined;
    };

/** The test every contribution is linked to, if it is one and the same. */
export function contributionsTest(
  contributions: readonly Contribution[],
): ExperimentId | 'none' | 'different' {
  const tests = new Set(
    contributions.map((item) => (item.subject?.type === 'experiment' ? item.subject.id : '')),
  );
  if (tests.has('')) return 'none';
  if (tests.size !== 1) return 'different';
  return [...tests][0] as ExperimentId;
}

/** Net confirmed revenue: payments minus refunds; preorders may still be returned. */
export function shareBase(flow: MoneyFlow | undefined): Money {
  if (flow === undefined) return usd(0);
  return usd(Math.max(0, flow.payments.amountCents - flow.refunds.amountCents));
}

/**
 * Checks the contributions and computes the reward by its rule. A refusal says why and, when it
 * is about one contribution, which.
 */
export function planReward(input: RewardPlanInput): RewardPlan {
  const [first] = input.contributions;
  if (first === undefined) return { ok: false, reason: 'empty' };
  const contributor = first.contributor;
  if (contributor.type !== 'member') return { ok: false, reason: 'not_a_member' };
  for (const contribution of input.contributions) {
    const refuse = (reason: RewardRefusal): RewardPlan => ({
      ok: false,
      reason,
      contributionId: contribution.id,
    });
    if (!sameActor(contribution.contributor, contributor)) return refuse('other_contributor');
    if (contribution.status !== 'verified') return refuse('not_verified');
    if (input.rewarded.has(contribution.id)) return refuse('already_rewarded');
  }
  const contributionIds = input.contributions.map((item) => item.id);

  if (input.terms.rule === 'fixed') {
    const { amount } = input.terms;
    if (amount.amountCents <= 0 || amount.amountCents > MAX_FIXED_REWARD.amountCents) {
      return { ok: false, reason: 'bad_amount' };
    }
    return {
      ok: true,
      reward: { contributor, contributionIds, amount, ruleId: REWARD_RULES.fixed },
    };
  }

  const { percent } = input.terms;
  if (!(percent > 0 && percent <= MAX_REVENUE_SHARE_PERCENT)) {
    return { ok: false, reason: 'bad_percent' };
  }
  const test = contributionsTest(input.contributions);
  if (test === 'none') return { ok: false, reason: 'no_test' };
  if (test === 'different') return { ok: false, reason: 'different_tests' };
  const base = shareBase(input.revenue);
  // Rounded down to whole cents: the code never pays more than the share.
  const cents = Math.floor((base.amountCents * Math.round(percent * 100)) / 10_000);
  if (cents <= 0) return { ok: false, reason: 'no_revenue' };
  return {
    ok: true,
    reward: {
      contributor,
      contributionIds,
      amount: usd(cents),
      ruleId: REWARD_RULES.revenue_share,
    },
    base,
  };
}
