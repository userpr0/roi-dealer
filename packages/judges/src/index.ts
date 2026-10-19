/**
 * @roi-dealer/judges — Judges (PHASE 11, constitution §2.3, §2.5, §2.13).
 *
 * Six independent judgements of each draft opportunity — market, pain and value, economics,
 * buildability, risk, reuse — one call of `judge-opportunity` per criterion on the strong models.
 * Code checks every answer, keeps only real citations and caps an evidence-bound score without
 * them; the panel result is computed by `judgePanel` in the domain. The judges submit a fully
 * judged opportunity for the owner's review; the owner decides (PHASE 12).
 */
import type { AnyAiTask } from '@roi-dealer/ai-runtime';
import { judgeOpportunityTask } from './judge-opportunity.js';

export {
  CRITERION_SCALES,
  JUDGE_EXCERPT_LENGTH,
  judgeOpportunityTask,
  MAX_JUDGE_EXCERPTS,
  scoreJudge,
  toJudgement,
  type CheckedJudgement,
  type JudgeExpected,
  type JudgeInput,
  type JudgeOutput,
} from './judge-opportunity.js';
export {
  JUDGES,
  JUDGES_ACCESS,
  judgesAgent,
  MARKET_WAIT_MS,
  type JudgesOptions,
} from './judges.js';

/** The AI tasks of the judges, for evals in the worker's maintenance. */
export const JUDGE_TASKS: readonly AnyAiTask[] = [judgeOpportunityTask];

export const PACKAGE_NAME = '@roi-dealer/judges';
