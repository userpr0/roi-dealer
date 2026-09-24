import { describe, expect, it } from 'vitest';
import { createHealthRegistry } from '@roi-dealer/observability';
import {
  createBotCommands,
  formatDuration,
  startedText,
  TEXT,
} from '../../../apps/bot/src/commands.js';
import { loadBotConfig } from '../../../apps/bot/src/config.js';
import { createCapturingLogger } from '../../support/logger.js';

const TOKEN = '1234567:TEST-fake-token-not-real-0000000000';

async function run(name: string, health = createHealthRegistry({ service: 'bot' })) {
  const replies: string[] = [];
  const commands = createBotCommands({
    health,
    version: 'abc123',
    environment: 'production',
    startedAt: 0,
    now: () => 2 * 3_600_000 + 5 * 60_000,
  });
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) throw new Error(`no command ${name}`);
  const { logger } = createCapturingLogger('bot');
  await command.handler({
    chatId: 1,
    userId: 1,
    args: '',
    logger,
    reply: (text) => {
      replies.push(text);
      return Promise.resolve();
    },
  });
  return replies;
}

describe('bot commands', () => {
  it('exposes start, status and help', () => {
    const names = createBotCommands({
      health: createHealthRegistry({ service: 'bot' }),
      version: 'v',
      environment: 'test',
      startedAt: 0,
    }).map((command) => command.name);
    expect(names).toEqual(['start', 'status', 'help']);
  });

  it('/status reports health, version, environment and uptime', async () => {
    const [reply] = await run('status');
    expect(reply).toBe(
      [
        '🟢 ROI Dealer: ok',
        'Сервис: bot',
        'Версия: abc123',
        'Окружение: production',
        'Работает: 2 ч 5 мин',
      ].join('\n'),
    );
  });

  it('/status lists dependency checks', async () => {
    const health = createHealthRegistry({ service: 'bot' });
    health.register({ name: 'database', check: () => Promise.resolve({ status: 'down' }) });

    const [reply] = await run('status', health);

    expect(reply).toContain('🔴 ROI Dealer: down');
    expect(reply).toContain('🔴 database: down');
  });

  it('/start and /help list the commands', async () => {
    expect((await run('start'))[0]).toContain('/status');
    expect(await run('help')).toEqual([TEXT.help]);
  });

  it('formats the startup notification', () => {
    expect(startedText({ version: 'abc', environment: 'production' })).toBe(
      '🟢 ROI Dealer bot запущен\nВерсия: abc\nОкружение: production',
    );
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '<1 мин'],
    [59_999, '<1 мин'],
    [60_000, '1 мин'],
    [14 * 60_000, '14 мин'],
    [2 * 3_600_000, '2 ч'],
    [2 * 3_600_000 + 5 * 60_000, '2 ч 5 мин'],
    [3 * 86_400_000, '3 д'],
    [3 * 86_400_000 + 4 * 3_600_000 + 59 * 60_000, '3 д 4 ч'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('bot config', () => {
  it('requires the token and the owner id', () => {
    expect(() => loadBotConfig({})).toThrow(/TELEGRAM_BOT_TOKEN.*TELEGRAM_OWNER_USER_ID/);
  });

  it('applies defaults', () => {
    expect(loadBotConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_USER_ID: '1001' })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_OWNER_USER_ID: 1001,
      TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
    });
  });

  it('rejects a non-numeric owner id', () => {
    expect(() =>
      loadBotConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_USER_ID: '@owner' }),
    ).toThrow(/TELEGRAM_OWNER_USER_ID/);
  });
});
