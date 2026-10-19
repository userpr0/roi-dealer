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
  /** Default: the official Gemini API; tests point it to a local fake. */
  readonly baseUrl?: string | undefined;
}

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
  // No `retryOptions`: the SDK does not retry, the runtime's router decides on fallbacks.
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { httpOptions: { baseUrl: options.baseUrl } }),
  });

  return {
    provider: 'google',

    async complete<Output>(request: CompletionRequest<Output>): Promise<Completion<Output>> {
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal =
        request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
      let usage: { inputTokens: number; outputTokens: number } | undefined;
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
        if (timeout.aborted) throw new ProviderFailure('timeout', usage);
        throw new ProviderFailure(
          error instanceof ApiError ? classifyError(error) : 'server_error',
          usage,
        );
      }
    },

    async listModels() {
      const ids: string[] = [];
      for await (const model of await client.models.list()) {
        if (model.name !== undefined) ids.push(model.name.replace(/^models\//, ''));
      }
      return ids;
    },
  };
}
