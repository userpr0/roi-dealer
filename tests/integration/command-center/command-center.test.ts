import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CONFIRMATION_TTL_MS,
  createCommandCenter,
  NO_DATABASE_TEXT,
  ownerActor,
  sendDailyDigest,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  approvalRequestIdSchema,
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  costEntryIdSchema,
  createApprovalRequest,
  createSource,
  recordCostEntry,
  sourceIdSchema,
  timestampMs,
  usd,
  type ApprovalRequest,
} from '@roi-dealer/domain';
import type { InlineKeyboard } from '@roi-dealer/telegram';
import { at, createCtx, sourceData, SYSTEM } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';

const OWNER_TG = 1001;
const OWNER = ownerActor(OWNER_TG);

let test: TestDatabase;
let db: Database;
let center: CommandCenter;
/** The command center's clock; tests move it. */
let clock = timestampMs(at(30));
const deliverDigest = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
const { logger } = createCapturingLogger('bot');

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  center = createCommandCenter({ database: db, logger, deliverDigest, now: () => clock });
});

afterAll(async () => {
  await center.stopDigest();
  await test.drop();
});

interface Message {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

async function command(name: string, args = ''): Promise<Message[]> {
  const replies: Message[] = [];
  const definition = center.commands.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`no command ${name}`);
  await definition.handler({
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: 1,
    args,
    logger,
    reply: (text, keyboard) => {
      replies.push({ text, keyboard });
      return Promise.resolve();
    },
  });
  return replies;
}

let nextUpdate = 100;

/** Presses a button; `queryId` repeats a delivery of the same press. */
async function press(data: string, queryId?: string) {
  const updateId = (nextUpdate += 1);
  const edits: Message[] = [];
  const answers: string[] = [];
  const separator = data.indexOf(':');
  const callback = center.callbacks.find((c) => c.prefix === data.slice(0, separator));
  if (callback === undefined) throw new Error(`no callback for ${data}`);
  await callback.handler({
    chatId: OWNER_TG,
    messageId: 5,
    userId: OWNER_TG,
    updateId,
    callbackQueryId: queryId ?? `q${updateId}`,
    data: data.slice(separator + 1),
    logger,
    edit: (text, keyboard) => {
      edits.push({ text, keyboard });
      return Promise.resolve();
    },
    reply: () => Promise.resolve(),
    answer: (text) => {
      answers.push(text);
      return Promise.resolve();
    },
  });
  return {
    edits,
    edit: edits.at(-1) ?? { text: '' },
    answers,
    correlationId: `tg-update-${updateId}`,
  };
}

function buttons(message: Message | undefined): string[] {
  return (message?.keyboard ?? []).flat().map((button) => button.callback_data);
}

async function pendingRequest(title: string, expiresInMinutes = 600): Promise<ApprovalRequest> {
  const request = createApprovalRequest(
    {
      kind: 'spend',
      title,
      summary: 'Domain for the landing page test',
      amount: usd(3_500),
      expiresAt: at(expiresInMinutes),
    },
    createCtx(approvalRequestIdSchema, SYSTEM, 0),
  );
  await db.repositories.approvalRequests.insert(request);
  return request;
}

describe('📥 decisions', () => {
  it('approves after a confirmation, once, with an event of the owner', async () => {
    const request = await pendingRequest('Buy a domain');

    const replies = await command('decisions');
    const card = replies.find((reply) => reply.text.includes('«Buy a domain»'));
    expect(card?.text).toContain('📥 Трата · $35.00');
    expect(buttons(card)).toEqual([`ap:a:${request.id}`, `ap:r:${request.id}`]);

    const question = await press(`ap:a:${request.id}`);
    expect(question.edit.text).toContain('❓ Одобрить «Buy a domain» на $35.00?');
    expect(buttons(question.edit)).toEqual([`ap:ya:${request.id}`, `ap:c:${request.id}`]);
    expect((await db.repositories.approvalRequests.getById(request.id))?.status).toBe('pending');

    const confirmed = await press(`ap:ya:${request.id}`, 'q-approve');
    expect(confirmed.edit.text).toContain('✅ Одобрено');
    expect(confirmed.edit.keyboard).toBeUndefined();
    expect(confirmed.answers).toEqual(['Одобрено']);

    const stored = await db.repositories.approvalRequests.getById(request.id);
    expect(stored).toMatchObject({
      status: 'approved',
      version: 2,
      resolution: { decidedBy: OWNER },
    });
    const history = await db.events.history({ type: 'approval_request', id: request.id });
    expect(history.at(-1)).toMatchObject({
      type: 'approval_request.updated',
      actor: OWNER,
      correlationId: confirmed.correlationId,
    });

    // The same press delivered again: nothing is done twice.
    const redelivered = await press(`ap:ya:${request.id}`, 'q-approve');
    expect(redelivered.edit.text).toContain('✅ Одобрено');
    expect(await db.events.history({ type: 'approval_request', id: request.id })).toHaveLength(2);

    // A new press on an old confirmation explains the state.
    const again = await press(`ap:yr:${request.id}`);
    expect(again.edit.text).toContain('✅ Уже одобрено');
    expect((await db.repositories.approvalRequests.getById(request.id))?.status).toBe('approved');
  });

  it('rejects, and cancel returns to the card', async () => {
    const request = await pendingRequest('Rent a server');

    const question = await press(`ap:r:${request.id}`);
    expect(question.edit.text).toContain('❓ Отклонить «Rent a server»?');
    const back = await press(`ap:c:${request.id}`);
    expect(buttons(back.edit)).toEqual([`ap:a:${request.id}`, `ap:r:${request.id}`]);

    const rejected = await press(`ap:yr:${request.id}`);
    expect(rejected.edit.text).toContain('❌ Отклонено');
    expect((await db.repositories.approvalRequests.getById(request.id))?.status).toBe('rejected');
  });

  it('explains an expired request and changes nothing', async () => {
    const request = await pendingRequest('Too late', 31);
    clock = timestampMs(at(40));
    try {
      expect((await command('decisions')).map((reply) => reply.text).join('\n')).not.toContain(
        'Too late',
      );
      const answer = await press(`ap:ya:${request.id}`);
      expect(answer.edit.text).toContain('⌛ Срок истёк');
      expect(answer.edit.keyboard).toBeUndefined();
      const stored = await db.repositories.approvalRequests.getById(request.id);
      expect(stored).toMatchObject({ status: 'pending', version: 1 });
    } finally {
      clock = timestampMs(at(30));
    }
  });

  it('refuses buttons with an unknown action or id with a notice only', async () => {
    for (const data of ['ap:zz:0190c5a6-7b8e-7c3d-9f00-123456789abc', 'ap:ya:not-an-id']) {
      const { edits, answers } = await press(data);
      expect(edits).toEqual([]);
      expect(answers).toEqual(['Кнопка устарела']);
    }
  });
});

describe('🛑 kill switch', () => {
  it('pauses after a confirmation, with the reason and the owner in /status', async () => {
    const [question] = await command('stop', 'Проверяю расходы');
    expect(question?.text).toContain('Причина: Проверяю расходы');
    const [confirm, cancel] = buttons(question);
    expect(confirm).toMatch(/^ks:y:[0-9a-f]{16}$/);
    expect(cancel).toMatch(/^ks:n:[0-9a-f]{16}$/);

    const done = await press(confirm ?? '');
    expect(done.edit.text).toContain('🛑 Автоматизации остановлены');

    const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    expect(control).toMatchObject({ status: 'paused', reason: 'Проверяю расходы' });
    expect(() => assertAutomationRunning(control ?? never())).toThrow(
      expect.objectContaining({ code: 'automation_paused' }),
    );
    const [event] = (
      await db.events.history({ type: 'system_control', id: AUTOMATION_CONTROL_ID })
    ).slice(-1);
    expect(event).toMatchObject({ actor: OWNER, correlationId: done.correlationId });

    const [status] = await center.statusLines();
    expect(status).toContain('🛑 Автоматизации: на паузе');
    expect(status).toContain('(Владелец)');
    expect(status).toContain('Причина: Проверяю расходы');

    const [already] = await command('stop');
    expect(already?.text).toContain('на паузе');
    expect(already?.keyboard).toBeUndefined();
  });

  it('resumes only after a confirmation that has not expired', async () => {
    const [first] = await command('resume');
    const [, cancel] = buttons(first);
    expect((await press(cancel ?? '')).edit.text).toContain('Отменено');

    const [second] = await command('resume');
    const [confirm] = buttons(second);
    clock += CONFIRMATION_TTL_MS + 1;
    try {
      expect((await press(confirm ?? '')).edit.text).toContain('⌛ Подтверждение устарело');
      expect((await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID))?.status).toBe(
        'paused',
      );

      const [third] = await command('resume');
      const [fresh] = buttons(third);
      expect((await press(fresh ?? '')).edit.text).toContain('▶️ Автоматизации возобновлены');
    } finally {
      clock = timestampMs(at(30));
    }
    const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    expect(control).toMatchObject({ status: 'running' });
    expect(control).not.toHaveProperty('reason');
    expect(await center.statusLines()).toEqual(['▶️ Автоматизации: работают']);
  });
});

describe('🧾 journal and 🕘 history', () => {
  it('show the events of the period in Kyiv time, history without research data', async () => {
    await db.repositories.sources.insert(
      createSource(sourceData({ name: 'r/dentists' }), createCtx(sourceIdSchema, SYSTEM, 1)),
    );

    const [choose] = await command('journal');
    expect(buttons(choose)).toEqual(['jr:day', 'jr:week', 'jr:month']);

    const journal = (await press('jr:day')).edit;
    expect(journal.text).toContain('🧾 Журнал за сутки (время по Киеву)');
    expect(journal.text).toContain('01.10 13:01 · Система · ➕ Источник «r/dentists» · active');
    expect(journal.text).toMatch(
      /Владелец · Запрос одобрения «Buy a domain» · \$35\.00: pending → approved/,
    );
    expect(journal.text).toContain('Стоп-кран: running → paused («Проверяю расходы»)');
    expect(journal.keyboard?.flat().map((button) => button.text)).toEqual([
      '• День',
      'Неделя',
      'Месяц',
    ]);

    const history = (await press('hs:day')).edit.text;
    expect(history).toContain('🕘 История за сутки');
    expect(history).toContain('Запрос одобрения «Buy a domain»');
    expect(history).not.toContain('r/dentists');
  });

  it('shows the latest 30 lines and counts the rest', async () => {
    for (let index = 0; index < 35; index += 1) {
      await db.repositories.sources.insert(
        createSource(sourceData({ name: `Source ${index}` }), createCtx(sourceIdSchema, SYSTEM, 2)),
      );
    }
    const text = (await press('jr:day')).edit.text;
    const lines = text.split('\n').filter((line) => line.startsWith('01.10 '));
    expect(lines).toHaveLength(30);
    expect(text).toMatch(/…и ещё \d+ раньше\. Показаны последние 30\./);
    expect(lines.at(-1)).toContain('Source 34');
  });
});

describe('📰 digest', () => {
  it('summarizes pending decisions, changes, costs and the kill switch', async () => {
    await pendingRequest('Waiting decision');
    const cost = recordCostEntry(
      {
        category: 'ai',
        amount: usd(1_250),
        description: 'OpenAI API',
        incurredAt: at(3),
        recurring: false,
        allocation: {},
      },
      createCtx(costEntryIdSchema, SYSTEM, 3),
    );
    await db.repositories.costEntries.insert(cost);

    const [digest] = await command('digest');
    expect(digest?.text).toContain('📰 Дайджест · 01.10.2026');
    expect(digest?.text).toMatch(/📥 Ждут решения: \d+ · ближайший срок \d\d\.\d\d \d\d:\d\d/);
    expect(digest?.text).toMatch(/🧾 За сутки изменений: \d+, ваших: \d+/);
    expect(digest?.text).toContain('💸 Расходы за сутки: $12.50 · записей: 1');
    expect(digest?.text).toContain('▶️ Автоматизации: работают');
  });

  it('is delivered once per Kyiv day, and a failed delivery can be retried', async () => {
    const deliver = vi.fn<(text: string) => Promise<void>>();
    deliver.mockRejectedValueOnce(new Error('telegram unavailable'));
    await expect(sendDailyDigest(db, '2026-10-01', clock, deliver)).rejects.toThrow(
      'telegram unavailable',
    );
    deliver.mockResolvedValue(undefined);

    await expect(sendDailyDigest(db, '2026-10-01', clock, deliver)).resolves.toBe('sent');
    await expect(sendDailyDigest(db, '2026-10-01', clock, deliver)).resolves.toBe('already_sent');
    await expect(sendDailyDigest(db, '2026-10-02', clock, deliver)).resolves.toBe('sent');
    expect(deliver).toHaveBeenCalledTimes(3);
  });
});

describe('without a database', () => {
  it('explains that the command center is not connected', async () => {
    const offline = createCommandCenter({ logger, deliverDigest });
    const decisions = offline.commands.find((candidate) => candidate.name === 'decisions');
    const replies: string[] = [];
    await decisions?.handler({
      chatId: 1,
      userId: 1,
      updateId: 1,
      args: '',
      logger,
      reply: (text) => {
        replies.push(text);
        return Promise.resolve();
      },
    });
    expect(replies).toEqual([NO_DATABASE_TEXT]);
    expect(offline.commands.map((candidate) => candidate.name)).toEqual(
      center.commands.map((candidate) => candidate.name),
    );
    expect(await offline.statusLines()).toEqual(['⚪ База данных не подключена: пульт недоступен']);
  });
});

function never(): never {
  throw new Error('unreachable');
}
