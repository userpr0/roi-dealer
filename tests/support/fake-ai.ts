import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export type FakeAiProvider = 'anthropic' | 'openai' | 'google';

/** What one model call sees: the model, the system instructions and the user prompt. */
export interface FakeAiRequest {
  readonly model: string;
  readonly instructions: string;
  readonly prompt: string;
}

/**
 * The answer of the fake: a text (JSON for structured output) with token counts, a stop
 * reason, or an HTTP error status.
 */
export type FakeAiAnswer =
  | {
      readonly text: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly stop?: 'refusal' | 'max_tokens';
      /** Answers this much later (to test timeouts). */
      readonly delayMs?: number;
    }
  | { readonly status: number };

export interface FakeAi {
  /** Base URL for `createAnthropicProvider` / `createOpenAiProvider` / `createGoogleProvider`. */
  readonly baseUrl: string;
  /** Model calls, in order. */
  readonly calls: readonly FakeAiRequest[];
  /** Every request path, in order (model calls and model lists). */
  readonly requests: readonly string[];
  /** The API keys that reached the server (to check that one is sent and none is logged). */
  readonly keys: ReadonlySet<string>;
  /** Replaces the answer function; the default answers `{}` . */
  answer(fn: (request: FakeAiRequest) => FakeAiAnswer): void;
  /** Ids the model list returns. */
  listModels(ids: readonly string[]): void;
  close(): Promise<void>;
}

const DEFAULT_TOKENS = { input: 120, output: 30 };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function errorBody(provider: FakeAiProvider, status: number): unknown {
  const message = `fake status ${String(status)}`;
  if (provider === 'anthropic') return { type: 'error', error: { type: 'api_error', message } };
  if (provider === 'google') return { error: { code: status, message, status: 'UNAVAILABLE' } };
  return { error: { message, type: 'server_error', code: null } };
}

/** The Anthropic Messages API: `{ content: [{ type: 'text' }], stop_reason, usage }`. */
function anthropicMessage(model: string, answer: Extract<FakeAiAnswer, { text: string }>): unknown {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: answer.text }],
    stop_reason: answer.stop ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: answer.inputTokens ?? DEFAULT_TOKENS.input,
      output_tokens: answer.outputTokens ?? DEFAULT_TOKENS.output,
    },
  };
}

/** The OpenAI Responses API: `{ output: [{ type: 'message', content: [...] }], status, usage }`. */
function openAiResponse(model: string, answer: Extract<FakeAiAnswer, { text: string }>): unknown {
  const content =
    answer.stop === 'refusal'
      ? [{ type: 'refusal', refusal: answer.text }]
      : [{ type: 'output_text', text: answer.text, annotations: [] }];
  const input = answer.inputTokens ?? DEFAULT_TOKENS.input;
  const output = answer.outputTokens ?? DEFAULT_TOKENS.output;
  return {
    id: 'resp_fake',
    object: 'response',
    created_at: Math.floor(Date.now() / 1_000),
    status: answer.stop === 'max_tokens' ? 'incomplete' : 'completed',
    model,
    output: [{ type: 'message', id: 'msg_fake', status: 'completed', role: 'assistant', content }],
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** The Gemini API: `{ candidates: [{ content: { parts }, finishReason }], usageMetadata }`. */
function geminiResponse(model: string, answer: Extract<FakeAiAnswer, { text: string }>): unknown {
  const finishReason =
    answer.stop === 'refusal' ? 'SAFETY' : answer.stop === 'max_tokens' ? 'MAX_TOKENS' : 'STOP';
  const input = answer.inputTokens ?? DEFAULT_TOKENS.input;
  const output = answer.outputTokens ?? DEFAULT_TOKENS.output;
  return {
    candidates: [
      {
        content: { role: 'model', parts: answer.stop === 'refusal' ? [] : [{ text: answer.text }] },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: input + output,
    },
    modelVersion: model,
  };
}

const CALL_PATHS: Readonly<Record<FakeAiProvider, RegExp>> = {
  anthropic: /^\/v1\/messages$/,
  openai: /^\/v1\/responses$/,
  google: /^\/v1beta\/models\/([^/:]+):generateContent$/,
};
const MODELS_PATHS: Readonly<Record<FakeAiProvider, string>> = {
  anthropic: '/v1/models',
  openai: '/v1/models',
  google: '/v1beta/models',
};

function modelList(provider: FakeAiProvider, ids: readonly string[]): unknown {
  if (provider === 'google') {
    return { models: ids.map((id) => ({ name: `models/${id}`, displayName: id })) };
  }
  const data = ids.map((id) =>
    provider === 'anthropic'
      ? { type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z' }
      : { id, object: 'model', created: 1_767_225_600, owned_by: 'fake' },
  );
  return provider === 'anthropic'
    ? { data, has_more: false, first_id: data[0]?.id ?? null, last_id: null }
    : { object: 'list', data };
}

type Body = Record<string, unknown>;
const textOf = (content: unknown): string =>
  String((content as { parts?: { text?: string }[] } | undefined)?.parts?.[0]?.text);

function readRequest(provider: FakeAiProvider, body: Body, pathModel: string | undefined) {
  if (provider === 'anthropic') {
    return {
      model: String(body['model']),
      instructions: String(body['system']),
      prompt: String((body['messages'] as { content: string }[])[0]?.content),
    };
  }
  if (provider === 'google') {
    return {
      model: pathModel ?? '',
      instructions: textOf(body['systemInstruction']),
      prompt: textOf((body['contents'] as unknown[])[0]),
    };
  }
  return {
    model: String(body['model']),
    instructions: String(body['instructions']),
    prompt: String(body['input']),
  };
}

/**
 * A local stand-in for the Anthropic, OpenAI or Gemini API: model calls (`/v1/messages`,
 * `/v1/responses`, `/v1beta/models/<id>:generateContent`) and the model list, in the shapes
 * the official SDKs read.
 */
export async function startFakeAi(provider: FakeAiProvider): Promise<FakeAi> {
  const calls: FakeAiRequest[] = [];
  const requests: string[] = [];
  const keys = new Set<string>();
  let answerFn: (request: FakeAiRequest) => FakeAiAnswer = () => ({ text: '{}' });
  let models: string[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    requests.push(path);
    const key =
      provider === 'anthropic'
        ? req.headers['x-api-key']
        : provider === 'google'
          ? req.headers['x-goog-api-key']
          : req.headers.authorization?.replace(/^Bearer /, '');
    if (typeof key === 'string') keys.add(key);

    if (req.method === 'GET' && path === MODELS_PATHS[provider]) {
      respond(res, 200, modelList(provider, models));
      return;
    }

    const match = CALL_PATHS[provider].exec(path);
    if (req.method !== 'POST' || match === null) {
      respond(res, 404, errorBody(provider, 404));
      return;
    }
    const request: FakeAiRequest = readRequest(provider, await readBody(req), match[1]);
    const { model } = request;
    calls.push(request);
    const answer = answerFn(request);
    if ('status' in answer) {
      respond(res, answer.status, errorBody(provider, answer.status));
      return;
    }
    if (answer.delayMs !== undefined) await delay(answer.delayMs);
    if (res.destroyed) return;
    respond(
      res,
      200,
      provider === 'anthropic'
        ? anthropicMessage(model, answer)
        : provider === 'google'
          ? geminiResponse(model, answer)
          : openAiResponse(model, answer),
    );
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => respond(res, 500, errorBody(provider, 500)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;

  return {
    // The Anthropic and Gemini SDKs append the API version; the OpenAI SDK expects it in the URL.
    baseUrl: provider === 'openai' ? `${origin}/v1` : origin,
    calls,
    requests,
    keys,
    answer(fn) {
      answerFn = fn;
    },
    listModels(ids) {
      models = [...ids];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** The text between the `"""` fences of a `redact-names` prompt. */
export function promptText(prompt: string): string {
  return /"""\n([\s\S]*)\n"""/.exec(prompt)?.[1] ?? '';
}
