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
}

export interface FakeTelegram {
  readonly baseUrl: string;
  readonly calls: readonly RecordedCall[];
  readonly sent: readonly SentMessage[];
  /** Queues an incoming private text message. */
  pushMessage(message: { fromId: number; text: string; chatType?: string }): void;
  waitForSent(
    predicate: (message: SentMessage) => boolean,
    timeoutMs?: number,
  ): Promise<SentMessage>;
  close(): Promise<void>;
}

interface Waiter {
  readonly offset: number;
  readonly respond: () => void;
}

/**
 * Minimal in-memory Telegram Bot API: getMe, getUpdates (long polling),
 * sendMessage, setMyCommands. Requests with another token get 401.
 */
export async function startFakeTelegram(token = FAKE_BOT_TOKEN): Promise<FakeTelegram> {
  const calls: RecordedCall[] = [];
  const sent: SentMessage[] = [];
  const updates: { update_id: number; message: Record<string, unknown> }[] = [];
  const pollers = new Set<Waiter>();
  const sentListeners = new Set<() => void>();
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
      case 'sendMessage':
        sent.push({ chatId: Number(params['chat_id']), text: String(params['text']) });
        sentListeners.forEach((notify) => notify());
        json(res, 200, { ok: true, result: { message_id: nextMessageId++ } });
        return;
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
    waitForSent(predicate, timeoutMs = 10_000) {
      return new Promise<SentMessage>((resolve, reject) => {
        const check = (): void => {
          const found = sent.find(predicate);
          if (found === undefined) return;
          cleanup();
          resolve(found);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`No matching sendMessage. Sent: ${JSON.stringify(sent)}`));
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          sentListeners.delete(check);
        };
        sentListeners.add(check);
        check();
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
