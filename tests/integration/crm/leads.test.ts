import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCommandCenter,
  createDecisionCardNotifier,
  ensureAccessRequest,
  type CommandCenter,
} from '@roi-dealer/command-center';
import { purgeExpiredContacts } from '@roi-dealer/crm';
import { ConstraintViolationError, translateError, type Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  resumeSystem,
  toTimestamp,
  type Experiment,
  type Lead,
  type MediaAsset,
  type Opportunity,
} from '@roi-dealer/domain';
import { createHealthRegistry } from '@roi-dealer/observability';
import {
  createSiteTracker,
  createSubmissionLimiter,
  landingPage,
  previewPage,
  privacyPage,
  SITE_ACCESS,
} from '@roi-dealer/site';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { createRouter } from '../../../apps/api/src/router.js';
import { startApiServer, type ApiServer } from '../../../apps/api/src/server.js';
import { approvedOpportunity, runningTest } from '../../support/cycle.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';
import { releasedLanding } from '../../support/site.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let server: ApiServer;
let api: string;
let opportunity: Opportunity;
let experiment: Experiment;
let landing: MediaAsset;
const { logger, records } = createCapturingLogger('api');
const OWNER_TG = 9393;
const CONTACT = 'privacy@example.test';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0) Firefox/131.0';
const ANNA = 'anna.k@example.org';
const now = () => toTimestamp(new Date());
let update = 7_000;

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

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${api}${path}`, { redirect: 'manual', headers: { 'user-agent': BROWSER, ...headers } });

/** Posts the sign-up form as a browser would. */
const join = (
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  query = '?utm_source=reddit',
) =>
  fetch(`${api}/l/${landing.slug}/join${query}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'user-agent': BROWSER,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });

async function leads(): Promise<Lead[]> {
  return db.repositories.leads.listByExperiments([experiment.id]);
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
  experiment = await runningTest(db, opportunity, { start: false });
  landing = await releasedLanding(db, opportunity, experiment);
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
    contactEmail: CONTACT,
    limiter: createSubmissionLimiter({ perVisitorPerHour: 4 }),
  };
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: createRouter({
      health: createHealthRegistry({ service: 'api' }),
      site: {
        preview: (token) => previewPage(db, token, { contactEmail: CONTACT }),
        landing: (slug, step, visit, form) => landingPage(pages, slug, step, visit, form),
        privacy: () => privacyPage(CONTACT),
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

describe('the sign-up form (PHASE 20)', () => {
  it('has a privacy notice and leads from the button to the form', async () => {
    const privacy = await get('/privacy');
    expect(privacy.status).toBe(200);
    const notice = await privacy.text();
    expect(notice).toContain(`write to ${CONTACT}`);
    expect(notice).toContain('180 days after the test ends');
    expect(await (await get(`/l/${landing.slug}`)).text()).toContain(
      '<a href="/privacy">Privacy</a>',
    );
    const go = await get(`/l/${landing.slug}/go?utm_source=reddit`);
    expect(go.status).toBe(303);
    expect(go.headers.get('location')).toBe(`/l/${landing.slug}/join?utm_source=reddit`);
    const form = await get(`/l/${landing.slug}/join?utm_source=reddit`);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain(
      `<form method="post" action="/l/${landing.slug}/join?utm_source=reddit">`,
    );
    expect(html).toContain('name="consent" value="yes" required');
    expect(html).toContain('<div class="hp" aria-hidden="true">');
    expect(html).not.toMatch(/<script/i);
  });

  it('stores nothing before the test starts (the crash test)', async () => {
    const response = await join({ email: ANNA, consent: 'yes' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/l/${landing.slug}/thanks`);
    expect(await leads()).toEqual([]);
    const go = await press(`ex:yg:${experiment.id}:${String(experiment.version)}`);
    expect(go.text).toContain('▶️ Тест идёт.');
  });

  it('asks again for a valid email and the consent; robots get nothing stored', async () => {
    const invalid = await join({ email: 'not-an-email', consent: 'yes' });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('Please enter a valid email address.');
    const noConsent = await join({ email: ANNA });
    expect(noConsent.status).toBe(400);
    expect(await noConsent.text()).toContain('Please tick the box to agree.');
    const robot = await join({ email: 'bot@spam.example', consent: 'yes', website: 'http://x' });
    expect(robot.status).toBe(303);
    expect(robot.headers.get('location')).toBe(`/l/${landing.slug}/joined`);
    expect(await leads()).toEqual([]);
  });

  it('records a sign-up once: the lead, its email apart, the funnel step', async () => {
    const response = await join({ email: '  Anna.K@Example.org ', consent: 'yes' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/l/${landing.slug}/joined`);
    const joined = await get(`/l/${landing.slug}/joined`);
    expect(await joined.text()).toContain(`write to ${CONTACT}`);
    expect(
      (await join({ email: ANNA, consent: 'yes' }, { 'x-forwarded-for': '203.0.113.20' })).status,
    ).toBe(303);

    const [lead] = await leads();
    expect(await leads()).toHaveLength(1);
    expect(lead).toMatchObject({
      status: 'new',
      channel: 'Reddit ads',
      utmSource: 'reddit',
      mediaAssetId: landing.id,
      createdBy: { type: 'integration', id: 'site' },
    });
    if (lead === undefined) throw new Error('no lead');
    expect(await db.leadContacts.emails([lead.id], OWNER)).toEqual(new Map([[lead.id, ANNA]]));
    const totals = await db.funnel.totals([experiment.id]);
    expect(totals.get(experiment.id)).toMatchObject({ lead: 1 });
    // The history and the logs hold no email.
    const history = await db.events.history({ type: 'lead', id: lead.id });
    expect(JSON.stringify(history)).not.toContain('anna');
    expect(JSON.stringify(records)).not.toContain('anna');
    // Only the owner reads emails.
    await expect(
      db.leadContacts.emails([lead.id], { type: 'integration', id: 'site' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('pauses sign-ups with the kill switch and limits a visitor', async () => {
    await setKillSwitch(true);
    const paused = await join(
      { email: 'paused@example.org', consent: 'yes' },
      {
        'x-forwarded-for': '198.51.100.30',
      },
    );
    expect(paused.status).toBe(503);
    await setKillSwitch(false);
    const visitor = { 'x-forwarded-for': '198.51.100.31' };
    for (let index = 0; index < 4; index += 1) {
      expect(
        (await join({ email: `p${String(index)}@example.org`, consent: 'yes' }, visitor)).status,
      ).toBe(303);
    }
    expect((await join({ email: 'p9@example.org', consent: 'yes' }, visitor)).status).toBe(429);
    expect(await leads()).toHaveLength(5);
  });
});

describe('leads in the panel (PHASE 20)', () => {
  it('sends one notice per new lead without the email', async () => {
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
    const notices = sent.filter((text) => text.startsWith('📥'));
    expect(notices).toHaveLength(5);
    expect(notices[0]).toBe(
      '📥 Новая заявка: тест №1 «Invoices that get paid» · Reddit ads. Почта и действия — /leads',
    );
    expect(notices.join('\n')).not.toContain('@');
    await notifier.runOnce();
    expect(sent.filter((text) => text.startsWith('📥'))).toHaveLength(5);
  });

  it('moves a lead to a customer and records the outcome with confirmation', async () => {
    const [anna] = await leads();
    if (anna === undefined) throw new Error('no lead');
    const [header, ...cards] = await command('leads');
    expect(header?.text).toContain('📥 Заявки: новых 5 · связались 0 · клиентов без итога 0');
    const card = cards.find((item) => item.text.includes(ANNA));
    expect(card?.text).toContain('📥 Заявка · тест №1 «Invoices that get paid»');
    expect(card?.text).toContain('Канал: Reddit ads · utm: reddit');
    expect(buttons(card)).toEqual([
      `ld:c:${anna.id}:1`,
      `ld:k:${anna.id}:1`,
      `ld:l:${anna.id}:1`,
      `ld:f:${anna.id}:1`,
    ]);
    expect((await press(`ld:c:${anna.id}:1`)).text).toContain('❓ Отметить: вы связались');
    expect((await press(`ld:yc:${anna.id}:1`)).text).toContain('Записано: ✉️ связались.');
    // A stale card changes nothing.
    expect((await press(`ld:yl:${anna.id}:1`)).text).toContain('Карточка устарела');
    expect((await press(`ld:yk:${anna.id}:2`)).text).toContain('Записано: 💰 клиент.');
    const customer = await press(`ld:b:${anna.id}:3`);
    expect(buttons(customer)).toEqual([
      `ld:oa:${anna.id}:3`,
      `ld:op:${anna.id}:3`,
      `ld:on:${anna.id}:3`,
      `ld:f:${anna.id}:3`,
    ]);
    expect((await press(`ld:yoa:${anna.id}:3`)).text).toContain(
      'Итог клиента записан: ✅ результат достигнут.',
    );
    const recorded = await db.repositories.leads.getById(anna.id);
    expect(recorded).toMatchObject({ status: 'customer', outcome: 'achieved' });
    const history = await db.events.history({ type: 'lead', id: anna.id });
    expect(history.at(-1)?.actor).toEqual({ type: 'owner', id: `telegram:${String(OWNER_TG)}` });
    expect((await db.funnel.totals([experiment.id])).get(experiment.id)).toMatchObject({
      outcome: 1,
    });
    const [refused] = await command('funnel', '1 заявки 3 результат 1');
    expect(refused?.text).toContain(
      '⛔ заявки, результат — у теста №1 их считают страница и /leads',
    );
  });

  it('deletes a person’s email on request, for real', async () => {
    expect((await command('forget', 'nobody@example.org'))[0]?.text).toBe(
      'Такой почты нет — удалять нечего.',
    );
    const [ask] = await command('forget', 'ANNA.K@example.org');
    expect(ask?.text).toContain(`❓ Удалить ${ANNA} из заявок: 1?`);
    const [confirm] = buttons(ask);
    if (confirm === undefined) throw new Error('no button');
    expect((await press(confirm)).text).toBe('🗑 Удалено: почта из заявок — 1.');
    const [anna] = await leads();
    if (anna === undefined) throw new Error('no lead');
    expect(anna.contactErasedAt).toBeDefined();
    expect(await db.leadContacts.emails([anna.id], OWNER)).toEqual(new Map());
    // The same press delivered again deletes nothing more.
    expect((await press(confirm)).text).toContain('Подтверждение устарело');
    // An erased lead never gets its email back.
    const error = await db.sql`
      insert into lead_contacts (lead_id, experiment_id, email, created_at)
      values (${anna.id}, ${experiment.id}, ${ANNA}, now())
    `.then(
      () => undefined,
      (caught: unknown) => translateError(caught),
    );
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect(error).toMatchObject({ constraint: 'lead_contacts_not_erased' });
    // A card button erases one lead's email too.
    const second = (await leads())[1];
    if (second === undefined) throw new Error('no second lead');
    expect((await press(`ld:yf:${second.id}:1`)).text).toContain('🗑 Почта удалена.');
  });

  it('erases emails of non-customers 180 days after the test, not before', async () => {
    const running = await db.repositories.experiments.getById(experiment.id);
    if (running === undefined) throw new Error('no experiment');
    expect((await press(`ex:ys:${running.id}:${String(running.version)}`)).text).toContain('⏹');
    const stopped = await db.repositories.experiments.getById(experiment.id);
    if (stopped === undefined) throw new Error('no experiment');
    await press(`ex:rp:${stopped.id}:${String(stopped.version)}`);
    expect((await db.repositories.experiments.getById(experiment.id))?.status).toBe('completed');
    expect((await get(`/l/${landing.slug}/join`)).status).toBe(410);

    const day = 86_400_000;
    await expect(
      purgeExpiredContacts({ database: db, logger, now: () => Date.now() + 179 * day }),
    ).resolves.toEqual({ erased: 0 });
    await expect(
      purgeExpiredContacts({ database: db, logger, now: () => Date.now() + 181 * day }),
    ).resolves.toEqual({ erased: 3 });
    const all = await leads();
    expect(all.filter((lead) => lead.contactErasedAt === undefined)).toEqual([]);
    expect(
      await db.leadContacts.emails(
        all.map((lead) => lead.id),
        OWNER,
      ),
    ).toEqual(new Map());
    const erased = all.at(-1);
    const history =
      erased === undefined ? [] : await db.events.history({ type: 'lead', id: erased.id });
    expect(history.at(-1)?.actor).toEqual({ type: 'system', id: 'lead-retention' });
    await setKillSwitch(true);
    await expect(
      purgeExpiredContacts({ database: db, logger, now: () => Date.now() + 181 * day }),
    ).rejects.toMatchObject({ code: 'automation_paused' });
    await setKillSwitch(false);
    expect(JSON.stringify(records)).not.toMatch(/p\d@example\.org/);
  });
});
