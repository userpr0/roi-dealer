import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDigest,
  createCommandCenter,
  sendWeeklyReview,
  statsText,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  createKnowledgeAsset,
  knowledgeAssetIdSchema,
  recordRevenueEntry,
  revenueEntryIdSchema,
  toTimestamp,
  usd,
  type Experiment,
  type Opportunity,
  type Pain,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { approvedOpportunity, runningTest } from '../../support/cycle.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let invoices: Opportunity;
let invoicesPain: Pain;
let overdueTest: Experiment;
const { logger } = createCapturingLogger('bot');
const OWNER_TG = 7171;
let update = 1_500;
const DAY_MS = 86_400_000;
const now = () => toTimestamp(new Date());

interface Message {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

async function run(name: string, args = ''): Promise<Message[]> {
  const replies: Message[] = [];
  const handler = cc.commands.find((item) => item.name === name)?.handler;
  if (handler === undefined) throw new Error(`no /${name}`);
  await handler({
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    args,
    logger,
    reply: (text, keyboard) => {
      replies.push({ text, keyboard });
      return Promise.resolve();
    },
  });
  return replies;
}

async function press(data: string): Promise<Message> {
  const edits: Message[] = [];
  const [prefix = ''] = data.split(':');
  const handler = cc.callbacks.find((item) => item.prefix === prefix)?.handler;
  if (handler === undefined) throw new Error(`no ${prefix} buttons`);
  const context: CallbackContext = {
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    callbackQueryId: `q-${String((update += 1))}`,
    messageId: 1,
    data: data.slice(prefix.length + 1),
    logger,
    answer: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    edit: (text, keyboard) => {
      edits.push({ text, keyboard });
      return Promise.resolve();
    },
  };
  await handler(context);
  return edits.at(-1) ?? { text: '' };
}

const buttons = (message: Message | undefined) =>
  (message?.keyboard ?? []).flat().map((item) => item.callback_data);

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  cc = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  // The signal came two days before the owner's decision.
  ({ opportunity: invoices, pain: invoicesPain } = await approvedOpportunity(
    db,
    'Invoices that get paid',
    { signalAtMs: Date.now() - 2 * DAY_MS },
  ));
  // A test started 15 days ago that reached its metric: past its 14 days.
  overdueTest = await runningTest(db, invoices, { startedAtMs: Date.now() - 15 * DAY_MS });
  await db.funnel.record(
    [
      {
        experimentId: overdueTest.id,
        hypothesisId: overdueTest.hypothesisId,
        stage: 'lead',
        quantity: 25,
        channel: 'Reddit ads',
        utm: {},
        occurredAt: now(),
        source: 'owner_report',
      },
    ],
    OWNER,
  );
  await db.repositories.revenueEntries.insert(
    recordRevenueEntry(
      {
        kind: 'payment',
        amount: usd(3_600),
        customers: 3,
        description: 'Owner report',
        receivedAt: now(),
        allocation: { experimentId: overdueTest.id },
      },
      { id: revenueEntryIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
    ),
  );
  for (const tags of [['experiment-result'], ['eval'], ['market-context']]) {
    await db.repositories.knowledgeAssets.insert(
      createKnowledgeAsset(
        {
          kind: 'knowledge',
          title: `Asset ${tags.join()}`,
          summary: 'Summary.',
          links: { evidenceIds: [] },
          tags,
        },
        { id: knowledgeAssetIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
      ),
    );
  }
});

afterAll(async () => {
  await test.drop();
});

describe('/stats (PHASE 13, D-014 п.11)', () => {
  it('shows the cycle and the system’s metrics from the database', async () => {
    const text = await statsText(db, Date.now());
    expect(text).toContain('За 30 дней:');
    expect(text).toContain('Доказательства 1 → сигналы 1 → боли 1 (подтверждено 0)');
    expect(text).toContain('Возможности 1 · на решении 0 · в работе 1');
    expect(text).toContain('Гипотезы 1 → тесты запущено 1, завершено 0');
    expect(text).toContain('Клиенты 3 · выручка $36.00');
    expect(text).toContain('От сигнала до решения: 2 дн. (медиана)');
    // Eval reports and market context are not knowledge of the cycle.
    expect(text).toContain('Новых знаний: 1');
    expect(text).toContain('Источник: таблицы БД');
    const [reply] = await run('stats');
    expect(reply?.text).toContain('📊 Статистика');
  });
});

describe('alerts and the weekly review (PHASE 13, D-014 п.12)', () => {
  it('the digest shows failed agent runs and overdue tests', async () => {
    const started = toTimestamp(new Date(Date.now() - 60_000));
    await db.agentRuns.record({
      agent: 'pain-analyst',
      startedAt: started,
      finishedAt: started,
      outcome: 'failed',
      processed: 0,
      failure: 'database_down',
    });
    const digest = await buildDigest(db, Date.now());
    expect(digest).toContain('⚠️ Сбоев агентов за сутки: 1 → /agents');
    expect(digest).toContain('⏰ Просроченных тестов: 1 → /experiments');
  });

  it('comes once on Monday with a proposal and its buttons; the owner decides', async () => {
    const sent: string[] = [];
    const cards: Message[] = [];
    const deliver = (text: string) => {
      sent.push(text);
      return Promise.resolve();
    };
    const deliverCard = (text: string, keyboard?: InlineKeyboard) => {
      cards.push({ text, keyboard });
      return Promise.resolve();
    };
    await expect(
      sendWeeklyReview(db, '2026-10-19', Date.now(), deliver, deliverCard),
    ).resolves.toBe('sent');
    await expect(
      sendWeeklyReview(db, '2026-10-19', Date.now(), deliver, deliverCard),
    ).resolves.toBe('already_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('🗓 Недельный разбор');
    expect(sent[0]).toContain('Решения по возможностям: проверять 1');
    expect(sent[0]).toContain(
      'Расходы месяца: $0.00 · Инфраструктура $0.00 из $20.00 · AI $0.00 из $50.00',
    );
    // The daily digest follows in the same message.
    expect(sent[0]).toContain('📰 Дайджест');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toContain(
      '💡 Предложение системы: 🚀 Масштабировать — метрика успеха достигнута. Решаете вы.',
    );
    expect(buttons(cards[0])).toEqual([
      `ex:qs:${overdueTest.id}:${String(overdueTest.version)}`,
      `ex:o:${overdueTest.id}:${String(overdueTest.version)}`,
    ]);
    // The proposal's button asks for confirmation like any result; nothing is decided yet.
    const asked = await press(`ex:qs:${overdueTest.id}:${String(overdueTest.version)}`);
    expect(asked.text).toContain('❓ 🚀 Масштабировать?');
    expect((await db.repositories.experiments.getById(overdueTest.id))?.status).toBe('running');
    const [manual] = await run('review');
    expect(manual?.text).toContain('🗓 Недельный разбор');
  });
});

describe('/portfolio (PHASE 13)', () => {
  it('pauses and resumes an opportunity; closing waits for its tests', async () => {
    const [header, card] = await run('portfolio');
    expect(header?.text).toContain('💼 Возможности в работе: 1');
    expect(card?.text).toContain('«Invoices that get paid» · 🧪 на проверке');
    expect(card?.text).toContain('Тесты: идут 1, завершены 0');
    expect(card?.text).toContain('выручка $36.00 · клиентов 3');
    const current = (await db.repositories.opportunities.getById(invoices.id)) ?? invoices;
    const v = String(current.version);
    expect(buttons(card)).toEqual([`pf:p:${invoices.id}:${v}`, `pf:k:${invoices.id}:${v}`]);

    const refused = await press(`pf:yp:${invoices.id}:${v}`);
    expect(refused.text).toContain('⛔ Сначала завершите или отмените незавершённые тесты: 1');

    const { opportunity: idle } = await approvedOpportunity(db, 'Rent that arrives on time');
    const asked = await press(`pf:p:${idle.id}:${String(idle.version)}`);
    expect(asked.text).toContain('❓ ⏸ Поставить «Rent that arrives on time» на паузу?');
    const paused = await press(`pf:yp:${idle.id}:${String(idle.version)}`);
    expect(paused.text).toContain('✅ Решение записано: ⏸ на паузе.');
    const stored = await db.repositories.opportunities.getById(idle.id);
    expect(stored?.status).toBe('paused');
    expect(buttons(paused)).toEqual([
      `pf:r:${idle.id}:${String(stored?.version)}`,
      `pf:k:${idle.id}:${String(stored?.version)}`,
    ]);
    // A stale card changes nothing.
    const stale = await press(`pf:yk:${idle.id}:${String(idle.version)}`);
    expect(stale.text).toContain('Карточка устарела');
    const resumed = await press(`pf:yr:${idle.id}:${String(stored?.version)}`);
    expect(resumed.text).toContain('✅ Решение записано: 🧪 на проверке.');
    const again = await db.repositories.opportunities.getById(idle.id);
    const closed = await press(`pf:yk:${idle.id}:${String(again?.version)}`);
    expect(closed.text).toContain('✅ Решение записано: ⛔ закрыта.');
    const decisions = await db.sql<{ outcome: string; created_by_type: string }[]>`
      select outcome, created_by_type from decisions where subject_id = ${idle.id}
      order by created_at, id
    `;
    expect(decisions.map((row) => row.outcome)).toEqual(['approve', 'pause', 'improve', 'kill']);
    expect(decisions.every((row) => row.created_by_type === 'owner')).toBe(true);
  });
});

describe('confirming a pain in /pains (D-030)', () => {
  it('shows ✅ and ✖️ for each pain, asks, then confirms it as the owner', async () => {
    const [reply] = await run('pains');
    expect(reply?.text).toContain('✅ N — подтвердить');
    const data = buttons(reply);
    expect(data.filter((item) => item.startsWith('pn:ok:'))).toHaveLength(
      data.filter((item) => item.startsWith('pn:x:')).length,
    );
    const confirm = data.find(
      (item) => item.startsWith('pn:ok:') && item.includes(invoicesPain.id),
    );
    if (confirm === undefined) throw new Error('no ✅ button');
    const asked = await press(confirm);
    expect(asked.text).toContain('❓ Подтвердить эту боль?');
    expect(asked.text).toContain('во втором источнике');
    const done = await press(confirm.replace('pn:ok:', 'pn:yok:'));
    expect(done.text).toContain('👍 Боль подтверждена');
    expect(done.text).toContain('👍 вы подтвердили');

    const pain = await db.repositories.pains.getById(invoicesPain.id);
    expect(pain?.ownerConfirmedAt).toBeDefined();
    expect(pain?.version).toBe(invoicesPain.version + 1);
    // The owner's confirmation does not make it a favorite: that needs two sources (§2.5).
    expect(pain?.status).toBe(invoicesPain.status);
    const history = await db.events.history({ type: 'pain', id: invoicesPain.id });
    expect(history.at(-1)?.actor).toEqual({ type: 'owner', id: `telegram:${String(OWNER_TG)}` });

    // The old button carries the old version: it changes nothing.
    const stale = await press(confirm.replace('pn:ok:', 'pn:yok:'));
    expect(stale.text).toContain('⚠️');
    expect((await db.repositories.pains.getById(invoicesPain.id))?.version).toBe(pain?.version);
  });
});

describe('rejecting a pain in /pains (PHASE 13)', () => {
  it('asks, then rejects it as the owner; it leaves the list', async () => {
    const [reply] = await run('pains');
    const reject = buttons(reply).find(
      (data) => data.startsWith('pn:x:') && data.includes(invoicesPain.id),
    );
    if (reject === undefined) throw new Error('no ✖️ button');
    const asked = await press(reject);
    expect(asked.text).toContain('❓ Отклонить эту боль?');
    const done = await press(reject.replace('pn:x:', 'pn:yx:'));
    expect(done.text).toContain('✖️ Боль отклонена.');
    const pain = await db.repositories.pains.getById(invoicesPain.id);
    expect(pain?.status).toBe('rejected');
    const [after] = await run('pains');
    expect(buttons(after).some((data) => data.includes(invoicesPain.id))).toBe(false);
    const history = await db.events.history({ type: 'pain', id: invoicesPain.id });
    expect(history.at(-1)?.actor).toEqual({ type: 'owner', id: `telegram:${String(OWNER_TG)}` });
  });
});
