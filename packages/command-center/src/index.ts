/**
 * @roi-dealer/command-center — the owner's command center in Telegram (13b, D-002, D-009, D-010;
 * access and its audit — PHASE 04; evidence in the digest and runs in the journal — PHASE 05).
 *
 * Approvals with a confirmation, the automation kill switch, the journal and history for a day,
 * week or month, and the daily digest at 10:00 Kyiv. Every change runs as an idempotent database
 * command through @roi-dealer/domain with the `owner` actor; apps/bot only wires it to Telegram.
 */
export {
  ACCESS_PREFIX,
  ACCESS_REQUEST_TTL_MS,
  applyAccessDecision,
  createAccessAudit,
  createSenderThrottle,
  ensureAccessRequest,
  handleAccessButton,
  principalCardText,
  REFUSED_THROTTLE_MS,
  requestAccess,
  sendAccessOverview,
  type AccessAudit,
  type AccessFlowDeps,
  type AccessRequestState,
  type RefusedAttempt,
} from './access.js';
export {
  APPROVAL_PREFIX,
  cardKeyboard,
  cardText,
  decidableRequests,
  handleApprovalButton,
  MAX_CARDS,
  sendDecisionCards,
  type ApprovalFlowDeps,
} from './approvals.js';
export {
  createCommandCenter,
  ownerActor,
  type CommandCenter,
  type CommandCenterOptions,
} from './command-center.js';
export {
  handlePainButton,
  NO_PAINS_TEXT,
  PAIN_PREFIX,
  painsReply,
  painsText,
  PAINS_SHOWN,
} from './pains.js';
export {
  handlePortfolioButton,
  MAX_PORTFOLIO_CARDS,
  PORTFOLIO_PREFIX,
  portfolioKeyboard,
  sendPortfolio,
} from './portfolio.js';
export {
  authorizePanel,
  panelSnapshot,
  type PanelAccess,
  type PanelCycle,
  type PanelSnapshot,
} from './panel.js';
export {
  isReviewDay,
  REVIEW_DAYS,
  sendWeeklyReview,
  STATS_DAYS,
  statsText,
  weeklyProposals,
  weeklyReviewText,
  type ReviewProposal,
} from './stats.js';
export {
  answerText,
  ASK_USAGE,
  askReply,
  createNoteFlow,
  NOTE_PREFIX,
  NOTE_USAGE,
  SEARCH_USAGE,
  searchReply,
  searchResultText,
} from './brain.js';
export {
  CRITERION_LABELS,
  judgesLines,
  marketLine,
  NO_OPPORTUNITIES_TEXT,
  OPPORTUNITIES_SHOWN,
  opportunitiesText,
} from './opportunities.js';
export { agentsText, NO_AGENTS_TEXT } from './agents.js';
export {
  costPerApprovedLanding,
  handleMediaButton,
  LANDING_TASK,
  landingCardText,
  landingCostLine,
  landingKeyboard,
  landingLine,
  MEDIA_PREFIX,
  previewUrl,
  type MediaFlowDeps,
} from './media.js';
export {
  applyPayoutDecision,
  CONTRIBUTION_KIND_LABELS,
  CONTRIBUTION_PREFIX,
  CONTRIBUTION_USAGE,
  createRewardFlow,
  memberActor,
  NO_CONTRIBUTIONS_TEXT,
  PAID_USAGE,
  parseContribution,
  parsePaid,
  parseRewardCommand,
  PAYOUT_REQUEST_DAYS,
  REWARD_PREFIX,
  REWARD_USAGE,
  rewardsDigestLine,
  rewardsReply,
  type ContributionInput,
  type PaidInput,
  type RewardFlow,
  type RewardFlowDeps,
  type RewardInput,
} from './rewards.js';
export {
  handleHypothesisButton,
  HYPOTHESES_SHOWN,
  hypothesesReadyText,
  hypothesesText,
  hypothesisCards,
  HYPOTHESIS_PREFIX,
  NO_HYPOTHESES_TEXT,
  sendHypotheses,
  type HypothesisCard,
} from './hypotheses.js';
export {
  COST_LABELS,
  COST_PREFIX,
  COST_USAGE,
  createCostFlow,
  economicsReply,
  economicsText,
  MAX_RECORDED_COST_USD,
  parseCostReport,
  type CostReport,
} from './economics.js';
export {
  applyExperimentLaunchDecision,
  ARTIFACT_LABELS,
  CHECK_LABELS,
  createFunnelFlow,
  EXPERIMENT_PREFIX,
  experimentCardText,
  experimentKeyboard,
  FUNNEL_PREFIX,
  FUNNEL_USAGE,
  FunnelRefusedError,
  handleExperimentButton,
  LAUNCH_REQUEST_DAYS,
  MAX_EXPERIMENT_CARDS,
  METHOD_LABELS,
  activeExperimentViews,
  EXPERIMENT_STATUS_LABELS,
  metricText,
  moneyLine,
  proposalKeyboard,
  parseFunnelReport,
  sendExperiments,
  STAGE_LABELS,
  type ExperimentView,
  type FunnelReport,
} from './experiments.js';
export {
  CARD_INTERVAL_MS,
  cardKeyboard as opportunityCardKeyboard,
  cardText as opportunityCardText,
  createDecisionCardNotifier,
  decisionRationale,
  handleOpportunityButton,
  loadCard,
  MAX_OPPORTUNITY_CARDS,
  OPPORTUNITY_PREFIX,
  reviewCount,
  reviewQueue,
  sendOpportunityCards,
  type CardData,
  type DecisionCardNotifier,
  type DecisionCardNotifierOptions,
  type OpportunityFlowDeps,
} from './opportunity-cards.js';
export {
  buildDigest,
  createDigestScheduler,
  DIGEST_HOUR,
  DIGEST_RETRY_MS,
  DIGEST_WINDOW_MS,
  sendDailyDigest,
  type DigestScheduler,
  type DigestSchedulerOptions,
} from './digest.js';
export {
  collectEvents,
  isHistoryEvent,
  isPeriod,
  journalText,
  MAX_LINES,
  PERIODS,
  type CollectedEvents,
  type JournalKind,
  type Period,
} from './journal.js';
export {
  CONFIRMATION_TTL_MS,
  createKillSwitchFlow,
  KILL_SWITCH_PREFIX,
  killSwitchStatus,
  loadAutomationControl,
  type KillSwitchDeps,
  type KillSwitchFlow,
} from './kill-switch.js';
export {
  formatKyivDate,
  formatKyivDateTime,
  KYIV_TIME_ZONE,
  kyivDate,
  kyivInstant,
  kyivTimeToday,
  nextKyivTime,
} from './kyiv-time.js';
export {
  actorLabel,
  APPROVAL_KIND_LABELS,
  describeEvent,
  ENTITY_LABELS,
  eventLine,
  NO_DATABASE_TEXT,
  shorten,
} from './texts.js';

export const PACKAGE_NAME = '@roi-dealer/command-center';
