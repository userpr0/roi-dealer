/**
 * @roi-dealer/ai-runtime — AI Runtime (PHASE 09, ADR-0006, D-007, D-012, D-014 п.7).
 *
 * One entry point for every AI task: `runTask`. A task runs only on models with a passing eval,
 * in the order the evals give (D-021: the cheapest passing model for bulk work, the best one for
 * judgement); a failure falls back to another provider (Claude, GPT, Gemini). Every answer is
 * checked with the task's schema, every attempt is journaled with its cost, and the kill switch
 * and the budget — $50 a month spread over the days, each task's share of the day — are checked
 * before each call. AI proposes; callers check and apply (§2.3). The domain never depends on a
 * provider (§2.4).
 */
import type { AnyAiTask } from './task.js';
import { redactNamesTask } from './tasks/redact-names.js';

export { previousUtcDate, recordDailyAiCost } from './daily-cost.js';
export {
  createAiMaintenance,
  type AiMaintenance,
  type AiMaintenanceOptions,
} from './maintenance.js';
export {
  callCostMicroUsd,
  MODEL_REGISTRY,
  modelTag,
  TASK_TIERS,
  type ModelSpec,
  type TaskTier,
} from './models.js';
export { createAnthropicProvider, type AnthropicProviderOptions } from './providers/anthropic.js';
export {
  createGoogleProvider,
  FREE_TIER_COOLDOWN_MS,
  type GoogleProviderOptions,
} from './providers/google.js';
export { createOpenAiProvider, type OpenAiProviderOptions } from './providers/openai.js';
export {
  classifyError,
  parseOutput,
  ProviderFailure,
  type AiProviderClient,
  type Completion,
  type CompletionRequest,
} from './providers/provider.js';
export {
  AI_RUNTIME_ACTOR,
  AiTaskError,
  createAiRuntime,
  routingOrder,
  type AiRuntime,
  type AiRuntimeOptions,
  type AiSpendToday,
  type AiTaskErrorCode,
  type Attempt,
  type EvalReport,
  type EvalSummary,
  type TaskContext,
} from './runtime.js';
export {
  EVAL_DAILY_SHARE,
  MIN_EVAL_CASES,
  type AiTask,
  type AnyAiTask,
  type EvalCase,
  type EvalScore,
} from './task.js';
export {
  applyNameRedaction,
  redactNames,
  redactNamesTask,
  scoreRedactNames,
  type RedactNamesInput,
  type RedactNamesOutput,
} from './tasks/redact-names.js';

/** Every task the worker evaluates on start. */
export const AI_TASKS: readonly AnyAiTask[] = [redactNamesTask];

export const PACKAGE_NAME = '@roi-dealer/ai-runtime';
