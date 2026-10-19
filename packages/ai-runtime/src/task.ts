import type { z } from 'zod';
import type { TaskTier } from './models.js';

/** One example of the golden set: an input and what a correct answer must contain. */
export interface EvalCase<Input, Expected> {
  readonly input: Input;
  readonly expected: Expected;
}

/** Quality of a set of answers; the task decides when it passes. */
export interface EvalScore {
  readonly passed: boolean;
  /** Named metrics in [0, 1], e.g. precision and recall. */
  readonly metrics: Readonly<Record<string, number>>;
}

/**
 * An AI task (PHASE 09): what the model gets, what it must return and how its quality is
 * measured. A new prompt is a new `version`: it runs only after its own eval.
 */
export interface AiTask<Input, Output, Expected = Output> {
  /** Lowercase, e.g. `redact-names`. */
  readonly name: string;
  readonly version: number;
  readonly tier: TaskTier;
  /** System instructions; the input is rendered into the user message. */
  readonly instructions: string;
  readonly input: z.ZodType<Input>;
  /** Structured output; anything that does not match is an `invalid_output` failure. */
  readonly output: z.ZodType<Output>;
  readonly render: (input: Input) => string;
  readonly maxOutputTokens: number;
  /** Upper bound of one call, in micro-USD: the budget check reserves it before calling. */
  readonly maxCostMicroUsd: number;
  /**
   * Share of today's AI allowance this task may use, in (0, 1] (D-021): every process keeps
   * its part of the day. The shares of all tasks and `EVAL_DAILY_SHARE` add up to at most 1.
   */
  readonly dailyShare: number;
  /** At least 20 examples (D-014 п.7). */
  readonly evalCases: readonly EvalCase<Input, Expected>[];
  readonly score: (
    results: readonly { readonly expected: Expected; readonly output: Output | undefined }[],
  ) => EvalScore;
}

/** Any task, for registries and routing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAiTask = AiTask<any, any, any>;

export const MIN_EVAL_CASES = 20;

/** Share of today's AI allowance for all eval runs together (D-021). */
export const EVAL_DAILY_SHARE = 0.2;
