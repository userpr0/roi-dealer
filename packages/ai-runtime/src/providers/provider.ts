import type { z } from 'zod';
import type { AiFailure, AiProvider } from '@roi-dealer/database';

export interface CompletionRequest<Output> {
  readonly model: string;
  readonly instructions: string;
  readonly prompt: string;
  readonly output: z.ZodType<Output>;
  /** Name of the output format, e.g. the task name. */
  readonly outputName: string;
  readonly maxOutputTokens: number;
  /** `low` for bulk extraction, `high` for judgement. */
  readonly effort: 'low' | 'high';
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export interface Completion<Output> {
  /** Validated against the request's output schema. */
  readonly output: Output;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A failed attempt with its class; tokens are known when the model answered. */
export class ProviderFailure extends Error {
  override readonly name = 'ProviderFailure';
  readonly failure: AiFailure;
  readonly inputTokens: number;
  readonly outputTokens: number;

  constructor(failure: AiFailure, usage: { inputTokens?: number; outputTokens?: number } = {}) {
    super(`AI provider call failed: ${failure}`);
    this.failure = failure;
    this.inputTokens = usage.inputTokens ?? 0;
    this.outputTokens = usage.outputTokens ?? 0;
  }
}

/**
 * Parses the model's JSON text with the task's schema. Anything else is `invalid_output`, with
 * the tokens of the answer: they are paid for and count against the budget.
 */
export function parseOutput<Output>(
  schema: z.ZodType<Output>,
  text: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): Output {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProviderFailure('invalid_output', usage);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProviderFailure('invalid_output', usage);
  return parsed.data;
}

/** One AI provider behind the runtime (ADR-0006); SDKs never leave the adapters. */
export interface AiProviderClient {
  readonly provider: AiProvider;
  /** Throws `ProviderFailure` on any failure. */
  complete<Output>(request: CompletionRequest<Output>): Promise<Completion<Output>>;
  /** Ids of the models this key may use. */
  listModels(): Promise<string[]>;
}

/**
 * Classifies an SDK error by its HTTP status or kind. Both official SDKs expose `status` on API
 * errors and name connection timeouts `APIConnectionTimeoutError`.
 */
export function classifyError(error: unknown): AiFailure {
  if (error instanceof ProviderFailure) return error.failure;
  if (!(error instanceof Error)) return 'server_error';
  if (error.name === 'APIConnectionTimeoutError' || error.name === 'TimeoutError') return 'timeout';
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  if (status === undefined) return 'server_error';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}
