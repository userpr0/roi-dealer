import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import {
  classifyError,
  parseOutput,
  ProviderFailure,
  type AiProviderClient,
  type Completion,
  type CompletionRequest,
} from './provider.js';

export interface GoogleProviderOptions {
  readonly apiKey: string;
  /**
   * A key of a project without billing (D-025): calls marked `freeTier` go there first and fall
   * back to `apiKey` when its quota or the key fails.
   */
  readonly freeApiKey?: string | undefined;
  /** Default: the official Gemini API; tests point it to a local fake. */
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/** After the free key fails (usually its quota), the paid key serves alone for this long. */
export const FREE_TIER_COOLDOWN_MS = 10 * 60_000;

/**
 * Failures of the free key the paid key answers instead (a slow free quota included); a wrong
 * or refused answer would repeat there.
 */
const PAID_RETRY: ReadonlySet<string> = new Set([
  'rate_limited',
  'timeout',
  'auth',
  'model_unavailable',
  'server_error',
  'bad_request',
]);

/** Stop reasons of a candidate that mean the model refused to answer. */
const REFUSALS: ReadonlySet<FinishReason> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

/** The task's schema as plain JSON Schema: the Gemini API accepts a subset, without `$schema`. */
function responseSchema(output: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(output);
  return schema;
}

/** Gemini through the official SDK `@google/genai` (ADR-0006, D-021). */
export function createGoogleProvider(options: GoogleProviderOptions): AiProviderClient {
  const now = options.now ?? Date.now;
  // No `retryOptions`: the SDK does not retry, the runtime's router decides on fallbacks.
  const clientFor = (apiKey: string) =>
    new GoogleGenAI({
      apiKey,
      ...(options.baseUrl === undefined ? {} : { httpOptions: { baseUrl: options.baseUrl } }),
    });
  const paid = clientFor(options.apiKey);
  const free = options.freeApiKey === undefined ? undefined : clientFor(options.freeApiKey);
  let freeBlockedUntil = 0;

  async function call<Output>(
    client: GoogleGenAI,
    request: CompletionRequest<Output>,
    isFree: boolean,
  ): Promise<Completion<Output>> {
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
    let usage: { inputTokens: number; outputTokens: number; free: boolean } | undefined;
    try {
      const response = await client.models.generateContent({
        model: request.model,
        contents: request.prompt,
        config: {
          systemInstruction: request.instructions,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: responseSchema(request.output),
          thinkingConfig: {
            thinkingLevel: request.effort === 'low' ? ThinkingLevel.LOW : ThinkingLevel.HIGH,
          },
          abortSignal: signal,
        },
      });
      // Thinking is billed as output.
      const meta = response.usageMetadata;
      usage = {
        inputTokens: meta?.promptTokenCount ?? 0,
        outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
        free: isFree,
      };
      const finish = response.candidates?.[0]?.finishReason;
      if (
        response.promptFeedback?.blockReason !== undefined ||
        (finish !== undefined && REFUSALS.has(finish))
      ) {
        throw new ProviderFailure('refusal', usage);
      }
      if (finish === FinishReason.MAX_TOKENS) throw new ProviderFailure('invalid_output', usage);
      return { output: parseOutput(request.output, response.text ?? '', usage), ...usage };
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      if (timeout.aborted) throw new ProviderFailure('timeout', { ...usage, free: isFree });
      throw new ProviderFailure(error instanceof ApiError ? classifyError(error) : 'server_error', {
        ...usage,
        free: isFree,
      });
    }
  }

  return {
    provider: 'google',

    async complete<Output>(request: CompletionRequest<Output>): Promise<Completion<Output>> {
      if (request.freeTier === true && free !== undefined && now() >= freeBlockedUntil) {
        try {
          return await call(free, request, true);
        } catch (error) {
          if (!(error instanceof ProviderFailure) || !PAID_RETRY.has(error.failure)) throw error;
          // The free quota is used up (or the key fails): the paid key answers for a while.
          freeBlockedUntil = now() + FREE_TIER_COOLDOWN_MS;
        }
      }
      return call(paid, request, false);
    },

    async listModels() {
      const ids: string[] = [];
      for await (const model of await paid.models.list()) {
        if (model.name !== undefined) ids.push(model.name.replace(/^models\//, ''));
      }
      return ids;
    },
  };
}
