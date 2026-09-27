import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Syntactically valid, obviously fake token. */
export const FAKE_BOT_TOKEN = '1234567:TEST-fake-token-not-real-0000000000';

export interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface SentMessage {
  readonly chatId: number;
  readonly text: string;
  /** `callback_data` of the inline buttons, row by row. */
  readonly buttons?: readonly string[];
}

export interface EditedMessage extends SentMessage {
  readonly messageId: number;
}

export interface FakeTelegram {
  readonly baseUrl: string;
  readonly calls: readonly RecordedCall[];
  readonly sent: readonly SentMessage[];
  readonly edits: readonly EditedMessage[];
  /** Queues an incoming private text message. */
  pushMessage(message: { fromId: number; text: string; chatType?: string }): void;
  /** Queues a press of an inline button; `queryId` repeats the delivery of one press. */
  pushCallback(press: { fromId: number; data: string; messageId?: number; queryId?: string }): void;
  waitForSent(
    predicate: (message: SentMessage) => boolean,
    timeoutMs?: number,
  ): Promise<SentMessage>;
  waitForEdit(
    predicate: (message: EditedMessage) => boolean,
    timeoutMs?: number,
  ): Promise<EditedMessage>;
  close(): Promise<void>;
}

function buttonsOf(params: Record<string, unknown>): string[] | undefined {
  const markup = params['reply_markup'] as
    { inline_keyboard?: { callback_data?: string }[][] } | undefined;
  return markup?.inline_keyboard?.flat().map((button) => String(button.callback_data));
}

function waitFor<T>(
  items: readonly T[],
  listeners: Set<() => void>,
  predicate: (item: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const check = (): void => {
      const found = items.find(predicate);
      if (found === undefined) return;
      cleanup();
      resolve(found);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No matching ${what}. Got: ${JSON.stringify(items)}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      listeners.delete(check);
    };
    listeners.add(check);
    check();
  });
}

interface Waiter {
  readonly offset: number;
  readonly respond: () => void;
}

/**
 * Minimal in-memory Telegram Bot API: getMe, getUpdates (long polling), sendMessage,
 * editMessageText, answerCallbackQuery, setMyCommands. Requests with another token get 401.
 */
export async function startFakeTelegram(token = FAKE_BOT_TOKEN): Promise<FakeTelegram> {
  const calls: RecordedCall[] = [];
  const sent: SentMessage[] = [];
  const edits: EditedMessage[] = [];
  const updates: ({ update_id: number } & Record<string, unknown>)[] = [];
  const pollers = new Set<Waiter>();
  const sentListeners = new Set<() => void>();
  const editListeners = new Set<() => void>();
  let nextUpdateId = 1;
  let nextMessageId = 1;

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const pending = (offset: number) => updates.filter((update) => update.update_id >= offset);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const params = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;

    if (match?.[1] !== token) {
      json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      return;
    }
    const method = match[2] ?? '';
    calls.push({ method, params });

    switch (method) {
      case 'getMe':
        json(res, 200, {
          ok: true,
          result: { id: 1234567, is_bot: true, first_name: 'ROI Dealer', username: 'roi_test_bot' },
        });
        return;
      case 'getUpdates': {
        const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
        const respond = (): void => {
          pollers.delete(waiter);
          if (!res.writableEnded) json(res, 200, { ok: true, result: pending(offset) });
        };
        const waiter: Waiter = { offset, respond };
        const timeoutSeconds = typeof params['timeout'] === 'number' ? params['timeout'] : 0;
        if (pending(offset).length > 0 || timeoutSeconds === 0) {
          respond();
          return;
        }
        // Hold the request like Telegram does, but never longer than 1 s in tests.
        pollers.add(waiter);
        const timer = setTimeout(respond, 1_000);
        res.on('close', () => {
          clearTimeout(timer);
          pollers.delete(waiter);
        });
        return;
      }
      case 'sendMessage': {
        const buttons = buttonsOf(params);
        sent.push({
          chatId: Number(params['chat_id']),
          text: String(params['text']),
          ...(buttons === undefined ? {} : { buttons }),
        });
        sentListeners.forEach((notify) => notify());
        json(res, 200, { ok: true, result: { message_id: nextMessageId++ } });
        return;
      }
      case 'editMessageText': {
        const buttons = buttonsOf(params);
        edits.push({
          chatId: Number(params['chat_id']),
          messageId: Number(params['message_id']),
          text: String(params['text']),
          ...(buttons === undefined ? {} : { buttons }),
        });
        editListeners.forEach((notify) => notify());
        json(res, 200, { ok: true, result: true });
        return;
      }
      case 'answerCallbackQuery':
      case 'setMyCommands':
        json(res, 200, { ok: true, result: true });
        return;
      default:
        json(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    sent,
    edits,
    pushMessage({ fromId, text, chatType = 'private' }) {
      const chatId = chatType === 'private' ? fromId : -100_000 - fromId;
      updates.push({
        update_id: nextUpdateId++,
        message: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: chatId, type: chatType },
          from: { id: fromId, is_bot: false, first_name: 'User' },
          text,
        },
      });
      for (const waiter of [...pollers]) waiter.respond();
    },
    pushCallback({ fromId, data, messageId = 1, queryId }) {
      const updateId = nextUpdateId++;
      updates.push({
        update_id: updateId,
        callback_query: {
          id: queryId ?? `cb${updateId}`,
          from: { id: fromId, is_bot: false, first_name: 'User' },
          message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1_000),
            chat: { id: fromId, type: 'private' },
          },
          chat_instance: '1',
          data,
        },
      });
      for (const waiter of [...pollers]) waiter.respond();
    },
    waitForSent: (predicate, timeoutMs = 10_000) =>
      waitFor(sent, sentListeners, predicate, timeoutMs, 'sendMessage'),
    waitForEdit: (predicate, timeoutMs = 10_000) =>
      waitFor(edits, editListeners, predicate, timeoutMs, 'editMessageText'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
