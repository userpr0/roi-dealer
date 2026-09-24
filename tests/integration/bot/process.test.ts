import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_BOT_TOKEN,
  startFakeTelegram,
  type FakeTelegram,
} from '../../support/fake-telegram.js';
import { startService, type ServiceProcess } from '../../support/service-process.js';

const OWNER_ID = 1001;
const STRANGER_ID = 666;

function botEnv(telegram: FakeTelegram, overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'debug',
    APP_VERSION: 'test-sha',
    TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: String(OWNER_ID),
    TELEGRAM_API_BASE_URL: telegram.baseUrl,
    ...overrides,
  };
}

describe('owner bot process', () => {
  let telegram: FakeTelegram;
  let service: ServiceProcess;

  beforeAll(async () => {
    telegram = await startFakeTelegram();
    service = startService('apps/bot/src/main.ts', botEnv(telegram));
  });

  afterAll(async () => {
    service.kill();
    await telegram.close();
  });

  it('announces startup to the owner and registers the command menu for the owner only', async () => {
    const started = await telegram.waitForSent((message) => message.text.includes('запущен'));

    expect(started.chatId).toBe(OWNER_ID);
    expect(started.text).toContain('test-sha');
    expect(telegram.calls).toContainEqual({
      method: 'setMyCommands',
      params: {
        commands: [
          { command: 'start', description: expect.any(String) as unknown },
          { command: 'status', description: expect.any(String) as unknown },
          { command: 'help', description: expect.any(String) as unknown },
        ],
        scope: { type: 'chat', chat_id: OWNER_ID },
      },
    });
  });

  it('answers /status to the owner', async () => {
    telegram.pushMessage({ fromId: OWNER_ID, text: '/status' });

    const reply = await telegram.waitForSent((message) => message.text.includes('ROI Dealer: '));

    expect(reply.chatId).toBe(OWNER_ID);
    expect(reply.text).toContain('🟢 ROI Dealer: ok');
    expect(reply.text).toContain('Версия: test-sha');
    expect(reply.text).toContain('Окружение: test');
  });

  it('ignores strangers and group chats', async () => {
    telegram.pushMessage({ fromId: STRANGER_ID, text: '/status' });
    telegram.pushMessage({ fromId: OWNER_ID, text: '/status', chatType: 'group' });
    telegram.pushMessage({ fromId: OWNER_ID, text: '/help' });

    await telegram.waitForSent((message) => message.text.startsWith('Команды:'));

    expect(telegram.sent.every((message) => message.chatId === OWNER_ID)).toBe(true);
    expect(service.logs).toContainEqual(
      expect.objectContaining({
        message: 'telegram message rejected: sender is not the owner',
        user_id: STRANGER_ID,
      }),
    );
  });

  it('answers unknown input with a hint', async () => {
    telegram.pushMessage({ fromId: OWNER_ID, text: 'привет' });
    await telegram.waitForSent((message) => message.text.startsWith('Неизвестная команда'));
  });

  it('notifies the owner and exits with code 0 on SIGTERM', async () => {
    service.child.kill('SIGTERM');

    await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    expect(telegram.sent.at(-1)).toEqual({
      chatId: OWNER_ID,
      text: '🔴 ROI Dealer bot остановлен',
    });
  });

  it('never logs the bot token or message text and writes only JSON', () => {
    const output = JSON.stringify(service.logs) + service.stderr();
    expect(output).not.toContain(FAKE_BOT_TOKEN);
    expect(output).not.toContain('привет');
    expect(service.logs.every((line) => line['service'] === 'bot')).toBe(true);
    expect(service.stderr()).toBe('');
  });
});

describe('owner bot process with a rejected token', () => {
  it('exits with code 1 without leaking the token', async () => {
    const telegram = await startFakeTelegram('7654321:ANOTHER-token-the-bot-does-not-have');
    const service = startService('apps/bot/src/main.ts', botEnv(telegram));

    try {
      await expect(service.waitForExit()).resolves.toMatchObject({ code: 1 });
      const fatal = service.logs.find((line) => line['level'] === 'fatal');
      expect(fatal?.['message']).toBe('bot failed to start');
      expect(JSON.stringify(fatal)).toContain('401');
      expect(JSON.stringify(service.logs)).not.toContain(FAKE_BOT_TOKEN);
      expect(telegram.sent).toEqual([]);
    } finally {
      service.kill();
      await telegram.close();
    }
  });
});

describe('owner bot process with invalid configuration', () => {
  it('refuses a malformed token without printing it', async () => {
    const service = startService('apps/bot/src/main.ts', {
      TELEGRAM_BOT_TOKEN: 'not-a-token',
      TELEGRAM_OWNER_USER_ID: String(OWNER_ID),
    });

    await expect(service.waitForExit()).resolves.toMatchObject({ code: 1 });
    const output = JSON.stringify(service.logs);
    expect(output).toContain('TELEGRAM_BOT_TOKEN');
    expect(output).not.toContain('not-a-token');
  });

  it('refuses plain http to a non-local Bot API host', async () => {
    const service = startService('apps/bot/src/main.ts', {
      TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
      TELEGRAM_OWNER_USER_ID: String(OWNER_ID),
      TELEGRAM_API_BASE_URL: 'http://api.telegram.org',
    });

    await expect(service.waitForExit()).resolves.toMatchObject({ code: 1 });
    expect(JSON.stringify(service.logs)).toContain('TELEGRAM_API_BASE_URL');
  });
});
