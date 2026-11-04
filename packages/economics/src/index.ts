/**
 * @roi-dealer/economics — Economic System (PHASE 16): the month against the D-007 limits, tests
 * against their approvals, revenue, ROI and the cost of a tested hypothesis from the ledgers,
 * and the spend guard that pauses automation on a spend anomaly (D-014 п.10). The rules
 * (limits, unit economics, the anomaly) live in `@roi-dealer/domain`.
 */
export { aiCents, monthReport, type BudgetLine, type EconomicsReport } from './report.js';
export {
  PROCESS_MIN_COST,
  PROCESS_VERDICTS,
  PROCESSES,
  processReport,
  BATCHABLE_TASKS,
  BATCH_THRESHOLD_MICRO_USD,
  processRoi,
  type ProcessDefinition,
  type ProcessLine,
  type ProcessOutputKey,
  type ProcessReport,
  type ProcessRoiInput,
  type ProcessVerdict,
} from './process-roi.js';
export {
  AUTO_PAUSE_PREFIX,
  createSpendGuard,
  runSpendGuard,
  SPEND_GUARD,
  type SpendGuard,
  type SpendGuardOptions,
  type SpendGuardOutcome,
  type SpendGuardResult,
} from './spend-guard.js';

export const PACKAGE_NAME = '@roi-dealer/economics';
