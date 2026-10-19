import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCommandCenter,
  createDecisionCardNotifier,
  ensureAccessRequest,
  releaseFacts,
  type CommandCenter,
} from '@roi-dealer/command-center';
import { ConstraintViolationError, type Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  recordRevenueEntry,
  releaseGate,
  resumeSystem,
  revenueEntryIdSchema,
  toTimestamp,
  usd,
  type Experiment,
  type MediaAsset,
  type Opportunity,
} from '@roi-dealer/domain';
import { createHealthRegistry } from '@roi-dealer/observability';
import { handleLemonSqueezyWebhook, PAYMENTS, PAYMENTS_ACCESS } from '@roi-dealer/payments';
import { uuidv7 } from '@roi-dealer/shared';
import {
  createSiteTracker,
  createSubmissionLimiter,
  landingPage,
  previewPage,
  privacyPage,
  SITE_ACCESS,
  SITE_TRACKER,
} from '@roi-dealer/site';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { createRouter } from '../../../apps/api/src/router.js';
import { startApiServer, type ApiServer } from '../../../apps/api/src/server.js';
import { approvedOpportunity, runningTest } from '../../support/cycle.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER } from '../../support/domain.js';
import { BUYER_EMAIL, orderBody, sign, type FakeOrder } from '../../support/fake-lemonsqueezy.js';
import { createCapturingLogger } from '../../support/logger.js';
import { releasedLanding } from '../../support/site.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let server: ApiServer;
let api: string;
let opportunity: Opportunity;
let preorder: Experiment;
let landing: MediaAsset;
const { logger, records } = createCapturingLogger('api');
const OWNER_TG = 9494;
const SECRET = 'whsec-roi-dealer-test-0123456789';
const TEST_LINK = 'https://mystore.lemonsqueezy.com/buy/test-2f1c9b7e';
const LIVE_LINK = 'https://mystore.lemonsqueezy.com/buy/live-8d0e4a21';
const BROWSER = 'Mozilla/5.0 (Macintosh) Safari/605.1.15';
const now = () => toTimestamp(new Date());
let update = 9_000;

interface Message {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
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

async function command(name: string, args = ''): Promise<Message[]> {
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

const buttons = (message: Message | undefined) =>
  (message?.keyboard ?? []).flat().map((item) => item.callback_data);

/** Delivers a webhook as Lemon Squeezy does; `signature` overrides the right one. */
function deliver(order: FakeOrder, signature?: string): Promise<Response> {
  const body = orderBody(order);
  return fetch(`${api}/webhooks/lemonsqueezy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature ?? sign(body, SECRET) },
    body,
  });
}

async function revenueRows() {
  return db.sql<
    {
      kind: string;
      amount_usd_cents: string;
      customers: number;
      experiment_id: string | null;
      created_by_id: string;
    }[]
  >`
    select kind, amount_usd_cents::text, customers, experiment_id, created_by_id
    from revenue_entries order by received_at, id
  `;
}

async function paymentRows() {
  return db.sql<{ kind: string; amount_usd_cents: string; experiment_id: string | null }[]>`
    select kind, amount_usd_cents::text, experiment_id from payment_events order by received_at, id
  `;
}

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) throw new Error('no kill switch');
  const next = paused
    ? pauseSystem(control, 'Проверка стоп-крана', { actor: OWNER, at: now() })
    : resumeSystem(control, { actor: OWNER, at: now() });
  await db.repositories.systemControls.update(next, OWNER);
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  cc = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  ({ opportunity } = await approvedOpportunity(db, 'Invoices that get paid'));
  preorder = await runningTest(db, opportunity, {
    start: false,
    hypothesis: { validationMethod: 'preorder', price: usd(4_900), offer: 'Preorder, $49 once' },
  });
  landing = await releasedLanding(db, opportunity, preorder);
  const { principal } = await ensureAccessRequest(db, SITE_ACCESS, { at: now() });
  await db.repositories.principals.update(
    approvePrincipal(principal, { actor: OWNER, at: now() }),
    OWNER,
  );
  const tracker = createSiteTracker({ database: db, logger, stateTtlMs: 0 });
  const pages = {
    database: db,
    tracker,
    logger,
    contactEmail: 'privacy@example.test',
    limiter: createSubmissionLimiter(),
  };
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: createRouter({
      health: createHealthRegistry({ service: 'api' }),
      site: {
        preview: (token) => previewPage(db, token),
        landing: (slug, step, visit, form) => landingPage(pages, slug, step, visit, form),
        privacy: () => privacyPage('privacy@example.test'),
      },
      payments: {
        lemonsqueezy: (body, signature, correlationId) =>
          handleLemonSqueezyWebhook(
            { database: db, logger },
            { body, signature, secret: SECRET, correlationId },
          ),
      },
    }),
    logger,
  });
  api = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.close();
  await test.drop();
});

describe('the payment link (PHASE 20b, ADR-0009)', () => {
  it('is set by the owner for a paid preorder, with confirmation', async () => {
    expect((await command('checkout', '1 https://evil.example/buy/1'))[0]?.text).toContain(
      '💳 Ссылка на оплату предзаказа',
    );
    const other = await runningTest(db, opportunity, { start: false });
    const numbers = (await command('experiments')).map((item) => item.text);
    expect(numbers.join('\n')).toContain('💳 Оплата: ссылки нет — /checkout 1');
    expect((await command('checkout', `2 ${TEST_LINK}`))[0]?.text).toContain(
      '⛔ Тест №2 — не платный предзаказ',
    );
    expect(other.id).toBeDefined();
    const [ask] = await command('checkout', `1 ${TEST_LINK}`);
    expect(ask?.text).toContain(`Станет: ${TEST_LINK}`);
    const [confirm] = buttons(ask);
    if (confirm === undefined) throw new Error('no button');
    expect((await press(confirm)).text).toContain('💳 Записано. Сделайте тестовую покупку');
    const [checkout] = await db.repositories.checkouts.listActiveByExperiments([preorder.id]);
    expect(checkout).toMatchObject({ url: TEST_LINK, createdBy: { type: 'owner' } });
    expect((await command('experiments'))[1]?.text).toContain(
      '💳 Оплата: Lemon Squeezy · ждёт тестовую покупку в Test mode',
    );
  });

  it('leads the page’s button to the checkout with the test', async () => {
    const response = await fetch(`${api}/l/${landing.slug}/go?utm_source=reddit`, {
      redirect: 'manual',
      headers: { 'user-agent': BROWSER },
    });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(TEST_LINK);
    expect(location.searchParams.get('checkout[custom][experiment_id]')).toBe(preorder.id);
    expect(location.searchParams.get('checkout[custom][utm_source]')).toBe('reddit');
  });
});

describe('the Lemon Squeezy webhook (PHASE 20b)', () => {
  const custom = () => ({ experiment_id: preorder.id, utm_source: 'reddit' });

  it('refuses a body without the right signature', async () => {
    const body = orderBody({ id: 1, totalUsd: 4_900 });
    expect(
      (await deliver({ id: 1, totalUsd: 4_900 }, sign(body, 'wrong-secret-value'))).status,
    ).toBe(401);
    expect(await deliver({ id: 1, totalUsd: 4_900 }, 'zz')).toHaveProperty('status', 401);
    expect(await paymentRows()).toEqual([]);
  });

  it('waits for the owner’s grant, then proves the payment flow with a test order', async () => {
    const testOrder = { id: 7001, totalUsd: 4_900, testMode: true, custom: custom() };
    expect((await deliver(testOrder)).status).toBe(503);
    const { principal } = await ensureAccessRequest(db, PAYMENTS_ACCESS, { at: now() });
    expect(principal.actor).toEqual(PAYMENTS);
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    expect((await deliver(testOrder)).status).toBe(200);
    expect((await deliver(testOrder)).status).toBe(200);
    expect(await paymentRows()).toEqual([
      { kind: 'test_order', amount_usd_cents: '4900', experiment_id: preorder.id },
    ]);
    const [checkout] = await db.repositories.checkouts.listActiveByExperiments([preorder.id]);
    expect(checkout?.testedAt).toBeDefined();
    const facts = await releaseFacts(db, landing);
    if (facts === undefined) throw new Error('no facts');
    expect(releaseGate(facts).find((item) => item.check === 'payment_flow')).toEqual({
      check: 'payment_flow',
      passed: true,
    });
    // No money from a test order.
    expect(await revenueRows()).toEqual([]);
    // The live link keeps the test.
    const [ask] = await command('checkout', `1 ${LIVE_LINK}`);
    const [confirm] = buttons(ask);
    if (confirm === undefined) throw new Error('no button');
    expect((await press(confirm)).text).toContain('Оплата уже проверена тестовым платежом');
  });

  it('records a paid preorder once: revenue without tax and the funnel step', async () => {
    const running = await db.repositories.experiments.getById(preorder.id);
    if (running === undefined) throw new Error('no experiment');
    expect((await press(`ex:yg:${running.id}:${String(running.version)}`)).text).toContain(
      '▶️ Тест идёт.',
    );
    const order = { id: 8001, totalUsd: 5_880, taxUsd: 980, custom: custom() };
    expect((await deliver(order)).status).toBe(200);
    expect((await deliver(order)).status).toBe(200);
    const revenue = await revenueRows();
    expect(revenue).toEqual([
      {
        kind: 'preorder',
        amount_usd_cents: '4900',
        customers: 1,
        experiment_id: preorder.id,
        created_by_id: 'lemonsqueezy',
      },
    ]);
    expect((await db.funnel.totals([preorder.id])).get(preorder.id)).toMatchObject({ payment: 1 });
    expect(JSON.stringify(revenue)).not.toContain(BUYER_EMAIL);
  });

  it('records refunds as the amount refunded since the last report', async () => {
    const refund = (refundedAmountUsd: number) =>
      deliver({
        event: 'order_refunded',
        id: 8001,
        totalUsd: 5_880,
        taxUsd: 980,
        refundedAmountUsd,
        custom: custom(),
      });
    expect((await refund(2_940)).status).toBe(200);
    expect((await refund(2_940)).status).toBe(200);
    expect((await refund(5_880)).status).toBe(200);
    const flow = (await db.economics.moneyFlows([preorder.id])).get(preorder.id);
    expect(flow?.refunds).toEqual(usd(4_900));
    expect((await paymentRows()).filter((row) => row.kind === 'refund')).toEqual([
      { kind: 'refund', amount_usd_cents: '2450', experiment_id: preorder.id },
      { kind: 'refund', amount_usd_cents: '2450', experiment_id: preorder.id },
    ]);
    // A provider's refund is money returned, not automated spend (spend guard, PHASE 16).
    const days = await db.economics.automatedSpendByDay({ days: 1, until: Date.now() });
    expect(days).toEqual([0]);
  });

  it('keeps an order without a test as unallocated revenue; pauses with the kill switch', async () => {
    expect((await deliver({ id: 9001, totalUsd: 1_000 })).status).toBe(200);
    expect((await revenueRows()).at(-1)).toMatchObject({
      kind: 'payment',
      amount_usd_cents: '1000',
      experiment_id: null,
    });
    await setKillSwitch(true);
    expect((await deliver({ id: 9002, totalUsd: 1_000 })).status).toBe(503);
    await setKillSwitch(false);
    expect((await deliver({ id: 9002, totalUsd: 1_000 })).status).toBe(200);
  });

  it('tells the owner about each event once, without buyer data', async () => {
    const sent: string[] = [];
    const notifier = createDecisionCardNotifier({
      database: db,
      logger,
      deliver: (text) => {
        sent.push(text);
        return Promise.resolve();
      },
    });
    await notifier.runOnce();
    const notices = sent.filter((text) => /^(✅ Тестовый|💰|↩️)/u.test(text));
    expect(notices).toEqual([
      '✅ Тестовый платёж дошёл: тест №1 «Invoices that get paid». Оплата проверена — можно ставить боевую ссылку (/checkout) и проходить Release Gate.',
      '💰 Оплата $49.00 без налога: тест №1 «Invoices that get paid». В выручке и воронке — сама.',
      '↩️ Возврат $24.50: тест №1 «Invoices that get paid». Записан в расходы теста.',
      '↩️ Возврат $24.50: тест №1 «Invoices that get paid». Записан в расходы теста.',
      '💰 Оплата $10.00 без налога: без теста (ссылка без номера теста). В выручке и воронке — сама.',
      '💰 Оплата $10.00 без налога: без теста (ссылка без номера теста). В выручке и воронке — сама.',
    ]);
    await notifier.runOnce();
    expect(sent.filter((text) => /^(✅ Тестовый|💰|↩️)/u.test(text))).toHaveLength(6);
  });

  it('lets only the payment provider write revenue among integrations; logs no buyer data', async () => {
    const write = db.repositories.revenueEntries.insert(
      recordRevenueEntry(
        {
          kind: 'payment',
          amount: usd(100),
          customers: 1,
          description: 'Not from the provider',
          receivedAt: now(),
          allocation: {},
        },
        { id: revenueEntryIdSchema.parse(uuidv7()), actor: SITE_TRACKER, at: now() },
      ),
    );
    await expect(write).rejects.toBeInstanceOf(ConstraintViolationError);
    await expect(write).rejects.toMatchObject({
      constraint: 'revenue_entries_integration_provider',
    });
    const logged = JSON.stringify(records);
    expect(logged).not.toContain(BUYER_EMAIL);
    expect(logged).not.toContain('Buyer Person');
    expect(logged).not.toContain(SECRET);
  });
});
