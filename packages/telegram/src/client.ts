import { z } from 'zod';
import {
  apiResponseSchema,
  telegramUpdateSchema,
  telegramUserSchema,
  type BotCommand,
  type BotCommandScope,
  type InlineKeyboard,
  type TelegramUpdate,
  type TelegramUser,
} from './api-types.js';
import { DEFAULT_TELEGRAM_API_BASE_URL } from './config.js';

/** Telegram answered `ok: false` (invalid token, rate limit, conflict, bad request…). */
export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';
  readonly method: string;
  /** HTTP-like code from Telegram: 401 invalid token, 409 conflict, 429 rate limit… */
  readonly errorCode: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(method: string, errorCode: number, description: string, retryAfterSeconds?: number) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.method = method;
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request did not produce a valid Bot API response (network error, timeout, malformed body). */
export class TelegramRequestError extends Error {
  override readonly name = 'TelegramRequestError';
  readonly method: string;

  constructor(method: string, reason: string) {
    super(`Telegram ${method} request failed: ${reason}`);
    this.method = method;
  }
}

export interface TelegramClientOptions {
  readonly token: string;
  /** Default: https://api.telegram.org */
  readonly baseUrl?: string;
  /** Per-request timeout, added on top of the long-poll timeout for `getUpdates`. Default: 10 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Injectable for tests. Default: global `fetch`. */
  readonly fetch?: typeof fetch;
}

export interface GetUpdatesParams {
  readonly offset?: number;
  /** Long-poll duration on Telegram's side. 0 returns immediately. */
  readonly timeoutSeconds: number;
  readonly allowedUpdates?: readonly string[];
}

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  /** Sends plain text (no parse mode, so user-provided text cannot inject markup). */
  sendMessage(params: {
    readonly chatId: number;
    readonly text: string;
    readonly keyboard?: InlineKeyboard | undefined;
  }): Promise<void>;
  /**
   * Replaces the text of a sent message; buttons are replaced by `keyboard` or removed.
   * Editing to the same text and buttons is not an error.
   */
  editMessageText(params: {
    readonly chatId: number;
    readonly messageId: number;
    readonly text: string;
    readonly keyboard?: InlineKeyboard | undefined;
  }): Promise<void>;
  /** Stops the loading indicator of a pressed button, optionally with a short notice. */
  answerCallbackQuery(params: {
    readonly callbackQueryId: string;
    readonly text?: string | undefined;
  }): Promise<void>;
  setMyCommands(params: {
    readonly commands: readonly BotCommand[];
    readonly scope?: BotCommandScope;
  }): Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Removes every occurrence of `secret` from `text`. */
export function redactSecret(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[REDACTED]');
}

function replyMarkup(keyboard: InlineKeyboard | undefined): Record<string, unknown> {
  return keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } };
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timed out';
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return `${error.message}${cause}`;
  }
  return 'unknown error';
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  const { token } = options;
  const baseUrl = (options.baseUrl ?? DEFAULT_TELEGRAM_API_BASE_URL).replace(/\/+$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  async function call(
    method: string,
    params: Readonly<Record<string, unknown>>,
    { signal, timeoutMs = requestTimeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: combined,
      });
    } catch (error) {
      // A caller-initiated abort (shutdown) is propagated unchanged.
      if (signal?.aborted === true) throw error;
      throw new TelegramRequestError(method, redactSecret(describeFailure(error), token));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramRequestError(method, `invalid JSON response (HTTP ${response.status})`);
    }

    const parsed = apiResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new TelegramRequestError(method, `unexpected response shape (HTTP ${response.status})`);
    }
    if (!parsed.data.ok) {
      throw new TelegramApiError(
        method,
        parsed.data.error_code ?? response.status,
        redactSecret(parsed.data.description ?? 'no description', token),
        parsed.data.parameters?.retry_after,
      );
    }
    return parsed.data.result;
  }

  function parseResult<T>(method: string, schema: z.ZodType<T>, result: unknown): T {
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new TelegramRequestError(method, 'unexpected result shape');
    return parsed.data;
  }

  return {
    async getMe() {
      return parseResult('getMe', telegramUserSchema, await call('getMe', {}));
    },

    async getUpdates(params, signal) {
      const result = await call(
        'getUpdates',
        {
          ...(params.offset === undefined ? {} : { offset: params.offset }),
          timeout: params.timeoutSeconds,
          ...(params.allowedUpdates === undefined
            ? {}
            : { allowed_updates: params.allowedUpdates }),
        },
        {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: params.timeoutSeconds * 1_000 + requestTimeoutMs,
        },
      );
      return parseResult('getUpdates', z.array(telegramUpdateSchema), result);
    },

    async sendMessage({ chatId, text, keyboard }) {
      await call('sendMessage', { chat_id: chatId, text, ...replyMarkup(keyboard) });
    },

    async editMessageText({ chatId, messageId, text, keyboard }) {
      try {
        await call('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
          ...replyMarkup(keyboard),
        });
      } catch (error) {
        // A repeated press renders the same content again: nothing to change.
        if (
          error instanceof TelegramApiError &&
          error.errorCode === 400 &&
          error.message.includes('message is not modified')
        ) {
          return;
        }
        throw error;
      }
    },

    async answerCallbackQuery({ callbackQueryId, text }) {
      await call('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text === undefined ? {} : { text }),
      });
    },

    async setMyCommands({ commands, scope }) {
      await call('setMyCommands', { commands, ...(scope === undefined ? {} : { scope }) });
    },
  };
}
