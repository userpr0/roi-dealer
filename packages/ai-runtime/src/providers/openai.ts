import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  classifyError,
  parseOutput,
  ProviderFailure,
  type AiProviderClient,
  type Completion,
  type CompletionRequest,
} from './provider.js';

export interface OpenAiProviderOptions {
  readonly apiKey: string;
  /** Default: the official API; tests point it to a local fake. */
  readonly baseUrl?: string | undefined;
}

/** GPT through the official SDK and the Responses API (ADR-0006). */
export function createOpenAiProvider(options: OpenAiProviderOptions): AiProviderClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    // The runtime's router decides on retries and fallbacks.
    maxRetries: 0,
  });

  return {
    provider: 'openai',

    async complete<Output>(request: CompletionRequest<Output>): Promise<Completion<Output>> {
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        // `create`, not `parse`: the answer is parsed here, after its tokens are known.
        const response = await client.responses.create(
          {
            model: request.model,
            instructions: request.instructions,
            input: request.prompt,
            max_output_tokens: request.maxOutputTokens,
            reasoning: { effort: request.effort },
            text: { format: zodTextFormat(request.output, request.outputName) },
            store: false,
          },
          {
            timeout: request.timeoutMs,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
        usage = {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        };
        const refused = response.output.some(
          (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
        );
        if (refused) throw new ProviderFailure('refusal', usage);
        if (response.status === 'incomplete') throw new ProviderFailure('invalid_output', usage);
        return { output: parseOutput(request.output, response.output_text, usage), ...usage };
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure(
          error instanceof OpenAI.APIConnectionTimeoutError ? 'timeout' : classifyError(error),
          usage,
        );
      }
    },

    async listModels() {
      const ids: string[] = [];
      for await (const model of client.models.list()) ids.push(model.id);
      return ids;
    },
  };
}
