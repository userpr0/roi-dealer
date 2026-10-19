/**
 * @roi-dealer/rewards — Reward Engine (PHASE 17, §2.10): the rules a reward is calculated by
 * and the checks before it — verified contributions of one team member, each rewarded once.
 * The owner sets the terms and approves every payout (D-006); nothing here pays.
 */
export {
  contributionsTest,
  MAX_FIXED_REWARD,
  MAX_REVENUE_SHARE_PERCENT,
  planReward,
  REWARD_RULES,
  shareBase,
  type RewardPlan,
  type RewardPlanInput,
  type RewardRefusal,
  type RewardRule,
  type RewardTerms,
} from './rules.js';

export const PACKAGE_NAME = '@roi-dealer/rewards';
