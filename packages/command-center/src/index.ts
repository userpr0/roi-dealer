/**
 * @roi-dealer/command-center — the owner's command center in Telegram (13b, D-002, D-009, D-010).
 *
 * Approvals with a confirmation, the automation kill switch, the journal and history for a day,
 * week or month, and the daily digest at 10:00 Kyiv. Every change runs as an idempotent database
 * command through @roi-dealer/domain with the `owner` actor; apps/bot only wires it to Telegram.
 */
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
