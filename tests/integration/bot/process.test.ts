import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approvalRequestIdSchema,
  AUTOMATION_CONTROL_ID,
  createApprovalRequest,
  createEvidence,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  JUDGE_CRITERIA,
  opportunityIdSchema,
  painIdSchema,
  resumeSystem,
  signalIdSchema,
  sourceIdSchema,
  submitOpportunityForReview,
  toTimestamp,
  usd,
  type SystemControl,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
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
          'start',
          'decisions',
          'stop',
          'resume',
          'journal',
          'history',
          'digest',
          'access',
          'pains',
          'opportunities',
          'search',
          'ask',
          'note',
          'hypotheses',
          'experiments',
          'funnel',
          'economics',
          'cost',
          'portfolio',
          'stats',
          'review',
          'agents',
          'sources',
          'rewards',
          'contribution',
          'reward',
          'paid',
          'leads',
          'forget',
          'checkout',
          'status',
          'help',
        ].map((command) => ({ command, description: expect.any(String) as unknown })),
        scope: { type: 'chat', chat_id: OWNER_ID },
      },
    });
    // Without the api's address the menu button stays as it is.
    expect(telegram.calls.map((call) => call.method)).not.toContain('setChatMenuButton');
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

  it('explains that the command center needs a database', async () => {
    telegram.pushMessage({ fromId: OWNER_ID, text: '/decisions' });
    await telegram.waitForSent((message) => message.text.includes('База данных не подключена'));
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

describe('owner bot process with a database (13b)', () => {
  let telegram: FakeTelegram;
  let database: TestDatabase;
  let service: ServiceProcess;

  beforeAll(async () => {
    telegram = await startFakeTelegram();
    database = await createTestDatabase();
    service = startService(
      'apps/bot/src/main.ts',
      botEnv(telegram, {
        DATABASE_URL: database.url,
        DECISION_CARDS_INTERVAL_MS: '200',
        PUBLIC_API_URL: 'https://api.example.test',
      }),
    );
    await telegram.waitForSent((message) => message.text.includes('запущен'));
  });

  afterAll(async () => {
    service.kill();
    await telegram.close();
    await database.drop();
  });

  it('sets the owner menu button to the Mini App connected to the api', () => {
    expect(telegram.calls).toContainEqual({
      method: 'setChatMenuButton',
      params: {
        chat_id: OWNER_ID,
        menu_button: {
          type: 'web_app',
          text: 'Пульт',
          web_app: {
            url: 'https://userpr0.github.io/roi-dealer/?api=https%3A%2F%2Fapi.example.test',
          },
        },
      },
    });
  });

  it('shows the database check and the kill switch in /status', async () => {
    telegram.pushMessage({ fromId: OWNER_ID, text: '/status' });
    const reply = await telegram.waitForSent((message) => message.text.includes('database: '));
    expect(reply.text).toContain('🟢 database: ok');
    expect(reply.text).toContain('▶️ Автоматизации: работают');
    // 13c: the checklist of what is left to set up, and the bot's own mark for the watchdog.
    expect(reply.text).toContain('🧭 Запуск — осталось 4:');
    expect(reply.text).toContain('✅ кнопка «Пульт»');
    await vi.waitFor(async () => {
      expect(await database.database.services.heartbeats()).toEqual([
        expect.objectContaining({ service: 'bot', version: 'test-sha', setup: { api_url: true } }),
      ]);
    });
  });

  it('pauses automation from Telegram after a confirmation, once', async () => {
    telegram.pushMessage({ fromId: OWNER_ID, text: '/stop Проверка из теста' });
    const question = await telegram.waitForSent((message) => message.text.includes('Остановить'));
    const confirm = question.buttons?.find((data) => data.startsWith('ks:y:'));
    expect(confirm).toBeDefined();

    // A stranger cannot press it; the owner's press is delivered twice.
    telegram.pushCallback({ fromId: STRANGER_ID, data: confirm ?? '' });
    telegram.pushCallback({ fromId: OWNER_ID, data: confirm ?? '', queryId: 'press-1' });
    telegram.pushCallback({ fromId: OWNER_ID, data: confirm ?? '', queryId: 'press-1' });
    await telegram.waitForEdit((edit) => edit.text.includes('Автоматизации остановлены'));
    await service.waitForLog(
      (line) => line['message'] === 'telegram button press handled' && telegram.edits.length >= 2,
    );

    const control =
      await database.database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    expect(control).toMatchObject({ status: 'paused', reason: 'Проверка из теста', version: 2 });
    const history = await database.database.events.history({
      type: 'system_control',
      id: AUTOMATION_CONTROL_ID,
    });
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      actor: { type: 'owner', id: `telegram:${OWNER_ID}` },
      correlationId: expect.stringMatching(/^tg-update-\d+$/) as unknown,
    });
    // The router answers a press after logging it as handled.
    await vi.waitFor(() => {
      expect(
        telegram.calls.filter((call) => call.method === 'answerCallbackQuery').length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(service.logs).toContainEqual(
      expect.objectContaining({
        message: 'telegram button press rejected: sender is not the owner',
        user_id: STRANGER_ID,
      }),
    );
  });

  it('approves a pending request with two presses', async () => {
    const request = createApprovalRequest(
      {
        kind: 'spend',
        title: 'Test domain',
        summary: 'Domain for the landing page test',
        amount: usd(3_500),
        expiresAt: toTimestamp(new Date(Date.now() + 3_600_000)),
      },
      { id: approvalRequestIdSchema.parse(uuidv7()), actor: SYSTEM, at: toTimestamp(new Date()) },
    );
    await database.database.repositories.approvalRequests.insert(request);

    telegram.pushMessage({ fromId: OWNER_ID, text: '/decisions' });
    const card = await telegram.waitForSent((message) => message.text.includes('«Test domain»'));
    expect(card.buttons).toEqual([`ap:a:${request.id}`, `ap:r:${request.id}`]);

    telegram.pushCallback({ fromId: OWNER_ID, data: `ap:a:${request.id}` });
    const question = await telegram.waitForEdit((edit) => edit.text.includes('❓ Одобрить'));
    telegram.pushCallback({ fromId: OWNER_ID, data: question.buttons?.[0] ?? '' });
    await telegram.waitForEdit((edit) => edit.text.includes('✅ Одобрено'));

    const stored = await database.database.repositories.approvalRequests.getById(request.id);
    expect(stored).toMatchObject({
      status: 'approved',
      resolution: { decidedBy: { type: 'owner', id: `telegram:${OWNER_ID}` } },
    });
  });

  it('sends a judged opportunity by itself and records the decision with two presses', async () => {
    const db = database.database;
    const at = () => toTimestamp(new Date());
    // An earlier test paused the automations; the card waits for them.
    const control = (await db.repositories.systemControls.getById(
      AUTOMATION_CONTROL_ID,
    )) as SystemControl;
    if (control.status === 'paused') {
      await db.repositories.systemControls.update(
        resumeSystem(control, { actor: OWNER, at: at() }),
        OWNER,
      );
    }
    const source = createSource(sourceData({ name: 'Forum' }), {
      id: sourceIdSchema.parse(uuidv7()),
      actor: SYSTEM,
      at: at(),
    });
    await db.repositories.sources.insert(source);
    const evidence = createEvidence(
      {
        sourceId: source.id,
        kind: 'post',
        excerpt: 'We pay $300 a month to chase invoices.',
        observedAt: at(),
      },
      { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: at() },
    );
    await db.repositories.evidence.insert(evidence);
    const signal = createSignal(
      {
        title: 'Late invoices',
        summary: 'Late invoices',
        evidenceIds: [evidence.id],
        markets: ['US'],
        strength: 'moderate',
      },
      { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: at() },
    );
    await db.repositories.signals.insert(signal);
    const pain = createPain(
      {
        title: 'Late invoices',
        description: 'Late invoices',
        audience: 'Freelancers',
        desiredOutcome: 'Paid on time',
        severity: 3,
        frequency: 'rare',
        markets: ['US'],
        signalIds: [signal.id],
        evidenceIds: [evidence.id],
      },
      { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: at() },
    );
    await db.repositories.pains.insert(pain);
    const draft = createOpportunity(
      {
        title: 'Invoices that get paid',
        summary: 'Freelancers chase late invoices.',
        painIds: [pain.id],
        icp: 'Freelancers',
        markets: ['US'],
        valueProposition: {
          problem: 'Late invoices',
          change: 'Automatic reminders',
          measurableResult: 'A day a month back',
        },
        businessModel: { model: 'subscription' },
      },
      { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: at() },
    );
    await db.repositories.opportunities.insert(draft);
    for (const criterion of JUDGE_CRITERIA) {
      await db.judgements.record({
        opportunityId: draft.id,
        opportunityVersion: 1,
        criterion,
        taskVersion: 1,
        outcome: 'judged',
        score: 4,
        supported: true,
        rationale: 'Freelancers already pay to chase invoices.',
        evidenceIds: [evidence.id],
        actorType: 'agent',
        actorId: 'judges',
      });
    }
    const opportunity = submitOpportunityForReview(draft, { actor: SYSTEM, at: at() });
    await db.repositories.opportunities.update(opportunity, SYSTEM);

    const card = await telegram.waitForSent((message) =>
      message.text.includes('«Invoices that get paid»'),
    );
    expect(card.text).toContain('💡 Возможность на решение');
    expect(card.text).toContain('Рекомендация системы: ✅ проверять');
    expect(card.buttons).toHaveLength(3);
    telegram.pushCallback({ fromId: OWNER_ID, data: card.buttons?.[0] ?? '' });
    const question = await telegram.waitForEdit((edit) => edit.text.includes('❓ Проверять'));
    telegram.pushCallback({ fromId: OWNER_ID, data: question.buttons?.[0] ?? '' });
    await telegram.waitForEdit((edit) => edit.text.includes('✅ Решение: проверять'));
    expect(await db.repositories.opportunities.getById(opportunity.id)).toMatchObject({
      status: 'approved',
    });
    // Sent once per version: no second card for the same opportunity.
    expect(
      telegram.sent.filter((message) => message.text.includes('«Invoices that get paid»')),
    ).toHaveLength(1);
  });

  it('shows the journal for a period', async () => {
    telegram.pushMessage({ fromId: OWNER_ID, text: '/journal' });
    const choose = await telegram.waitForSent((message) => message.text.startsWith('🧾 Журнал:'));
    expect(choose.buttons).toEqual(['jr:day', 'jr:week', 'jr:month']);
    telegram.pushCallback({ fromId: OWNER_ID, data: 'jr:day' });
    const journal = await telegram.waitForEdit((edit) => edit.text.includes('Журнал за сутки'));
    expect(journal.text).toContain('Стоп-кран: running → paused («Проверка из теста»)');
    expect(journal.text).toContain('Запрос одобрения «Test domain» · $35.00: pending → approved');
  });

  it('records refused attempts and owner views in the access log, without message text', async () => {
    telegram.pushMessage({ fromId: STRANGER_ID, text: '/access секретный вопрос' });
    telegram.pushMessage({ fromId: OWNER_ID, text: '/access' });
    await telegram.waitForSent((message) => message.text.startsWith('🔐 Доступы'));

    const log = await database.database.access.list({ limit: 100 });
    const refused = log.filter((entry) => entry.actorId === `telegram:${STRANGER_ID}`);
    // The stranger's button press earlier and this message: one record per 10 minutes.
    expect(refused).toEqual([
      expect.objectContaining({
        channel: 'telegram',
        permission: 'panel.use',
        decision: 'denied',
        reason: 'not_owner',
      }),
    ]);
    const ownerViews = log
      .filter((entry) => entry.actorId === `telegram:${OWNER_ID}`)
      .map((entry) => entry.permission);
    expect(ownerViews).toEqual(
      expect.arrayContaining([
        'access.read',
        'journal.read',
        'decisions.read',
        'approval.update',
        'system.control',
        'status.read',
      ]),
    );
    expect(JSON.stringify(log)).not.toContain('секретный');
  });

  it('closes the database on SIGTERM and never logs message text', async () => {
    service.child.kill('SIGTERM');
    await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    const output = JSON.stringify(service.logs) + service.stderr();
    expect(output).not.toContain('Проверка из теста');
    expect(output).not.toContain(FAKE_BOT_TOKEN);
    expect(output).not.toContain(database.url);
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
