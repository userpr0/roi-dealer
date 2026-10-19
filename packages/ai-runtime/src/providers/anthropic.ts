import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  classifyError,
  parseOutput,
  ProviderFailure,
  type AiProviderClient,
  type Completion,
  type CompletionRequest,
} from './provider.js';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /** Default: the official API; tests point it to a local fake. */
  readonly baseUrl?: string | undefined;
}

/** Claude through the official SDK (ADR-0006): structured output validated by the task's schema. */
export function createAnthropicProvider(options: AnthropicProviderOptions): AiProviderClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    // The runtime's router decides on retries and fallbacks.
    maxRetries: 0,
  });

  return {
    provider: 'anthropic',

    async complete<Output>(request: CompletionRequest<Output>): Promise<Completion<Output>> {
      // The JSON schema only: the answer is parsed here, after its tokens are known.
      const { schema } = zodOutputFormat(request.output);
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        const response = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.instructions,
            messages: [{ role: 'user', content: request.prompt }],
            output_config: { effort: request.effort, format: { type: 'json_schema', schema } },
          },
          {
            timeout: request.timeoutMs,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
        usage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
        if (response.stop_reason === 'refusal') throw new ProviderFailure('refusal', usage);
        if (response.stop_reason === 'max_tokens')
          throw new ProviderFailure('invalid_output', usage);
        const text = response.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('');
        return { output: parseOutput(request.output, text, usage), ...usage };
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure(
          error instanceof Anthropic.APIConnectionTimeoutError ? 'timeout' : classifyError(error),
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
