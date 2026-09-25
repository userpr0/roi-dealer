import { describe, expect, it, vi } from 'vitest';
import {
  createTelegramClient,
  redactSecret,
  TelegramApiError,
  TelegramRequestError,
  telegramApiBaseUrlSchema,
  telegramBotTokenSchema,
} from '@roi-dealer/telegram';

const TOKEN = '1234567:TEST-fake-token-not-real-0000000000';

function fakeFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function requestOf(fetchMock: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  if (typeof url !== 'string' || typeof init?.body !== 'string') {
    throw new Error('expected a string URL and a JSON string body');
  }
  return { url, body: JSON.parse(init.body) as Record<string, unknown> };
}

describe('createTelegramClient', () => {
  it('posts JSON to /bot<token>/<method> and returns the parsed result', async () => {
    const fetchMock = fakeFetch({
      ok: true,
      result: { id: 42, is_bot: true, first_name: 'ROI', username: 'roi_bot', extra: 'ignored' },
    });
    const client = createTelegramClient({ token: TOKEN, fetch: fetchMock });

    await expect(client.getMe()).resolves.toEqual({
      id: 42,
      is_bot: true,
      first_name: 'ROI',
      username: 'roi_bot',
    });
    expect(requestOf(fetchMock).url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('sends getUpdates parameters in Bot API format', async () => {
    const fetchMock = fakeFetch({ ok: true, result: [] });
    const client = createTelegramClient({
      token: TOKEN,
      baseUrl: 'http://127.0.0.1:8081/',
      fetch: fetchMock,
    });

    await client.getUpdates({ offset: 7, timeoutSeconds: 30, allowedUpdates: ['message'] });

    const request = requestOf(fetchMock);
    expect(request.url).toBe(`http://127.0.0.1:8081/bot${TOKEN}/getUpdates`);
    expect(request.body).toEqual({ offset: 7, timeout: 30, allowed_updates: ['message'] });
  });

  it('drops malformed messages instead of failing the batch', async () => {
    const client = createTelegramClient({
      token: TOKEN,
      fetch: fakeFetch({
        ok: true,
        result: [
          {
            update_id: 1,
            message: { message_id: 1, date: 0, chat: { id: 5, type: 'private' }, text: 'hi' },
          },
          { update_id: 2, message: { broken: true } },
          { update_id: 3, edited_message: {} },
        ],
      }),
    });

    const updates = await client.getUpdates({ timeoutSeconds: 0 });

    expect(updates.map((update) => update.update_id)).toEqual([1, 2, 3]);
    expect(updates[0]?.message?.text).toBe('hi');
    expect(updates[1]?.message).toBeUndefined();
  });

  it('parses button presses and drops malformed ones', async () => {
    const client = createTelegramClient({
      token: TOKEN,
      fetch: fakeFetch({
        ok: true,
        result: [
          {
            update_id: 4,
            callback_query: {
              id: '4382bfdwdsb323b2d9',
              from: { id: 5, is_bot: false, first_name: 'Owner' },
              message: { message_id: 9, date: 0, chat: { id: 5, type: 'private' } },
              chat_instance: '-1',
              data: 'ap:x',
            },
          },
          { update_id: 5, callback_query: { id: 'x', data: 'ap:x' } },
        ],
      }),
    });

    const [valid, broken] = await client.getUpdates({ timeoutSeconds: 0 });

    expect(valid?.callback_query).toEqual({
      id: '4382bfdwdsb323b2d9',
      from: { id: 5, is_bot: false, first_name: 'Owner' },
      message: { message_id: 9, date: 0, chat: { id: 5, type: 'private' } },
      data: 'ap:x',
    });
    expect(broken?.callback_query).toBeUndefined();
  });

  it('sends inline keyboards, edits messages and answers button presses', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }))),
    );
    const client = createTelegramClient({ token: TOKEN, fetch: fetchMock });
    const keyboard = [[{ text: 'Да', callback_data: 'ks:y:1' }]];

    await client.sendMessage({ chatId: 1, text: 'Остановить?', keyboard });
    await client.editMessageText({ chatId: 1, messageId: 9, text: 'Остановлено' });
    await client.answerCallbackQuery({ callbackQueryId: 'q1', text: 'Готово' });

    const bodies = fetchMock.mock.calls.map(([url, init]) => [
      typeof url === 'string' ? url.split('/').at(-1) : undefined,
      typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    ]);
    expect(bodies).toEqual([
      [
        'sendMessage',
        { chat_id: 1, text: 'Остановить?', reply_markup: { inline_keyboard: keyboard } },
      ],
      ['editMessageText', { chat_id: 1, message_id: 9, text: 'Остановлено' }],
      ['answerCallbackQuery', { callback_query_id: 'q1', text: 'Готово' }],
    ]);
  });

  it('treats an edit to the same content as done', async () => {
    const notModified = {
      ok: false,
      error_code: 400,
      description:
        'Bad Request: message is not modified: specified new message content is the same',
    };
    await expect(
      createTelegramClient({ token: TOKEN, fetch: fakeFetch(notModified, 400) }).editMessageText({
        chatId: 1,
        messageId: 9,
        text: 'same',
      }),
    ).resolves.toBeUndefined();
    await expect(
      createTelegramClient({
        token: TOKEN,
        fetch: fakeFetch(
          { ...notModified, description: 'Bad Request: message to edit not found' },
          400,
        ),
      }).editMessageText({ chatId: 1, messageId: 9, text: 'x' }),
    ).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('turns ok:false into TelegramApiError with code and retry_after', async () => {
    const client = createTelegramClient({
      token: TOKEN,
      fetch: fakeFetch(
        {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        },
        429,
      ),
    });

    const error = await client.sendMessage({ chatId: 1, text: 'x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ method: 'sendMessage', errorCode: 429, retryAfterSeconds: 3 });
  });

  it('reports network failures without the token', async () => {
    const client = createTelegramClient({
      token: TOKEN,
      fetch: () => Promise.reject(new TypeError(`fetch failed for /bot${TOKEN}/getMe`)),
    });

    const error = await client.getMe().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramRequestError);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).toContain('[REDACTED]');
  });

  it('rejects non-JSON and unexpected response shapes', async () => {
    await expect(
      createTelegramClient({ token: TOKEN, fetch: fakeFetch('<html>', 502) }).getMe(),
    ).rejects.toThrow(/invalid JSON response \(HTTP 502\)/);
    await expect(
      createTelegramClient({
        token: TOKEN,
        fetch: fakeFetch({ ok: true, result: { id: 'x' } }),
      }).getMe(),
    ).rejects.toThrow(/unexpected result shape/);
  });

  it('propagates a caller abort unchanged', async () => {
    const controller = new AbortController();
    const client = createTelegramClient({
      token: TOKEN,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });

    const pending = client.getUpdates({ timeoutSeconds: 30 }, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('telegram config schemas', () => {
  it('accepts BotFather tokens and rejects anything else', () => {
    expect(telegramBotTokenSchema.safeParse(TOKEN).success).toBe(true);
    expect(telegramBotTokenSchema.safeParse('123:short').success).toBe(false);
    expect(telegramBotTokenSchema.safeParse('not-a-token').success).toBe(false);
  });

  it('requires https except for loopback hosts', () => {
    expect(telegramApiBaseUrlSchema.parse('https://api.telegram.org/')).toBe(
      'https://api.telegram.org',
    );
    expect(telegramApiBaseUrlSchema.safeParse('http://127.0.0.1:8081').success).toBe(true);
    expect(telegramApiBaseUrlSchema.safeParse('http://localhost:8081').success).toBe(true);
    expect(telegramApiBaseUrlSchema.safeParse('http://api.telegram.org').success).toBe(false);
  });

  it('redacts every occurrence of a secret', () => {
    expect(redactSecret('a-SECRET-b-SECRET', 'SECRET')).toBe('a-[REDACTED]-b-[REDACTED]');
    expect(redactSecret('unchanged', '')).toBe('unchanged');
  });
});
