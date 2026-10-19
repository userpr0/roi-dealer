/**
 * @roi-dealer/signals — Signals & Pain (PHASE 06).
 *
 * The pain analyst reads each new Evidence once: the AI (`extract-signal`) says whether it shows
 * a pain and normalizes it into one statement; code keeps it only when the quote is really in
 * the text. Similar statements are grouped — word similarity first, then the AI (`match-pain`)
 * on the closest few — into pain candidates with their evidence. The agent writes through its
 * own identity granted by the owner; it proposes and never decides (§2.3).
 */
import type { AnyAiTask } from '@roi-dealer/ai-runtime';
import { extractSignalTask } from './tasks/extract-signal.js';
import { matchPainTask } from './tasks/match-pain.js';

export {
  analyzeEvidence,
  assertSignalsRunning,
  PAIN_ANALYST,
  PAIN_ANALYST_ACCESS,
  type AnalysisOutcome,
  type AnalysisStop,
  type SignalsDeps,
} from './analyze.js';
export {
  createSignalsScheduler,
  type EnsureAccess,
  type SignalsScheduler,
  type SignalsSchedulerOptions,
} from './scheduler.js';
export {
  closestPains,
  MAX_CANDIDATES,
  MIN_SIMILARITY,
  painTerms,
  termSimilarity,
} from './similarity.js';
export {
  extractSignalTask,
  quoteInText,
  scoreExtractSignal,
  toSignalDraft,
  type ExtractSignalExpected,
  type ExtractSignalInput,
  type ExtractSignalOutput,
  type SignalDraft,
} from './tasks/extract-signal.js';
export {
  matchedKey,
  matchPainTask,
  MAX_MATCH_CANDIDATES,
  NO_MATCH,
  scoreMatchPain,
  type MatchPainInput,
  type MatchPainOutput,
} from './tasks/match-pain.js';

/** The AI tasks of this package; the worker evaluates them with the others. */
export const SIGNAL_TASKS: readonly AnyAiTask[] = [extractSignalTask, matchPainTask];

export const PACKAGE_NAME = '@roi-dealer/signals';
