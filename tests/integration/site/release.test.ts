import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCommandCenter,
  ensureAccessRequest,
  type CommandCenter,
} from '@roi-dealer/command-center';
import { ConstraintViolationError, translateError, type Database } from '@roi-dealer/database';
import {
  approveMediaAsset,
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  createMediaAsset,
  mediaAssetIdSchema,
  pauseSystem,
  resumeSystem,
  suspendPrincipal,
  toTimestamp,
  type Experiment,
  type MediaAsset,
  type Opportunity,
} from '@roi-dealer/domain';
import { checkLanding, landingSlug, newPreviewToken } from '@roi-dealer/media';
import { createHealthRegistry } from '@roi-dealer/observability';
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
import { OWNER, SYSTEM } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';
import { perfectLandingAnswer } from '../../support/media-answers.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let server: ApiServer;
let api: string;
let opportunity: Opportunity;
let experiment: Experiment;
let landing: MediaAsset;
const { logger, records } = createCapturingLogger('api');
const OWNER_TG = 9292;
const PUBLIC_API_URL = 'https://api.example.test';
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
const now = () => toTimestamp(new Date());
let update = 5_000;

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

const visit = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  fetch(`${api}${path}`, {
    method,
    redirect: 'manual',
    headers: { 'user-agent': BROWSER, ...headers },
  });

async function current(): Promise<MediaAsset> {
  const asset = await db.repositories.mediaAssets.getById(landing.id);
  if (asset === undefined) throw new Error('no landing');
  return asset;
}

async function trackerEvents() {
  return db.sql<{ stage: string; utm_source: string | null; channel: string; actor_id: string }[]>`
    select stage, utm_source, channel, actor_id from experiment_events
    where experiment_id = ${experiment.id} and source = 'tracker' order by recorded_at, id
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
  cc = createCommandCenter({
    database: db,
    logger,
    deliverDigest: () => Promise.resolve(),
    publicApiUrl: PUBLIC_API_URL,
  });
  ({ opportunity } = await approvedOpportunity(db, 'Invoices that get paid'));
  // The launch is approved; the test is not started yet.
  experiment = await runningTest(db, opportunity, { start: false });
  const hypothesis = await db.repositories.hypotheses.getById(experiment.hypothesisId);
  if (hypothesis === undefined) throw new Error('no hypothesis');
  const checked = checkLanding(
    {
      opportunity: {
        title: opportunity.title,
        icp: opportunity.icp,
        problem: opportunity.valueProposition.problem,
        change: opportunity.valueProposition.change,
        measurableResult: opportunity.valueProposition.measurableResult,
      },
      hypothesis: {
        audience: hypothesis.audience,
        offer: hypothesis.offer,
        priceUsd: hypothesis.price.amountCents / 100,
        channel: hypothesis.channel,
        creative: hypothesis.creative,
        cta: hypothesis.cta,
        method: hypothesis.validationMethod,
      },
      rejectedHeadline: '',
      feedback: '',
    },
    perfectLandingAnswer({
      opportunity: {
        ...opportunity.valueProposition,
        title: opportunity.title,
        icp: opportunity.icp,
      },
      hypothesis: {
        audience: hypothesis.audience,
        offer: hypothesis.offer,
        priceUsd: 49,
        channel: hypothesis.channel,
        creative: hypothesis.creative,
        cta: hypothesis.cta,
        method: 'landing_page',
      },
    }),
  );
  if (!('content' in checked)) throw new Error(checked.issues.join('; '));
  const id = mediaAssetIdSchema.parse(uuidv7());
  const draft = createMediaAsset(
    {
      kind: 'landing',
      experimentId: experiment.id,
      hypothesisId: experiment.hypothesisId,
      opportunityId: experiment.opportunityId,
      content: checked.content,
      slug: landingSlug(opportunity.title, id),
      previewToken: newPreviewToken(),
    },
    { id, actor: SYSTEM, at: now() },
  );
  await db.repositories.mediaAssets.insert(draft);
  landing = approveMediaAsset(draft, { actor: OWNER, at: now() });
  await db.repositories.mediaAssets.update(landing, OWNER);

  // No cache of the kill switch and the access, so the test sees every change at once.
  const tracker = createSiteTracker({ database: db, logger, stateTtlMs: 0 });
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: createRouter({
      health: createHealthRegistry({ service: 'api' }),
      site: {
        preview: (token) => previewPage(db, token),
        landing: (slug, step, request) =>
          landingPage(
            { database: db, tracker, logger, limiter: createSubmissionLimiter() },
            slug,
            step,
            request,
          ),
        privacy: () => privacyPage(undefined),
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

describe('the Release Gate (PHASE 21, §7.2)', () => {
  it('keeps the page private and the test unstarted until the release', async () => {
    expect((await visit(`/l/${landing.slug}`)).status).toBe(404);
    const [, card] = await command('experiments');
    expect(card?.text).toContain('🎨 Лендинг: ✅ одобрен — дальше 🚦 Release Gate');
    expect(buttons(card)).toContain(`ma:c:${landing.id}:${String(landing.version)}`);
    const go = await press(`ex:yg:${experiment.id}:${String(experiment.version)}`);
    expect(go.text).toContain('⛔ Сначала выпустите лендинг');
    expect((await db.repositories.experiments.getById(experiment.id))?.status).toBe('approved');
  });

  it('shows what fails and how to fix it; the release waits for the page counter', async () => {
    const opened = await press(`ma:c:${landing.id}:${String(landing.version)}`);
    expect(buttons(opened)).toEqual([`ma:g:${landing.id}:${String(landing.version)}`]);
    const gate = await press(`ma:g:${landing.id}:${String(landing.version)}`);
    expect(gate.text).toContain('🚦 Release Gate (§7.2)');
    expect(gate.text).toContain('✅ Лендинг одобрен вами');
    expect(gate.text).toContain('✅ Запуск теста одобрен: бюджет, stop-loss, лимиты');
    expect(gate.text).toContain('✅ Страница без скриптов и внешних адресов');
    expect(gate.text).toContain(
      '❌ Счётчик воронки работает — одобрите «Доступ: Сайт тестов» в /decisions',
    );
    expect(gate.text).not.toContain('Оплата проверена');
    expect(buttons(gate)).toEqual([`ma:c:${landing.id}:${String(landing.version)}`]);
    // Pressing a stale confirmation does not release a page that fails the gate.
    const forced = await press(`ma:yg:${landing.id}:${String(landing.version)}`);
    expect(forced.text).toContain('❌ Счётчик воронки работает');
    expect((await current()).status).toBe('approved');
  });

  it('releases the page with the owner’s confirmations in one owner command', async () => {
    const { principal } = await ensureAccessRequest(db, SITE_ACCESS, { at: now() });
    expect(principal.actor).toEqual(SITE_TRACKER);
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    const gate = await press(`ma:g:${landing.id}:${String(landing.version)}`);
    expect(gate.text).toContain('✅ Счётчик воронки работает');
    expect(gate.text).toContain('2–3 человека открыли предпросмотр без подсказок');
    expect(buttons(gate)).toEqual([
      `ma:yg:${landing.id}:${String(landing.version)}`,
      `ma:c:${landing.id}:${String(landing.version)}`,
    ]);
    const released = await press(`ma:yg:${landing.id}:${String(landing.version)}`);
    expect(released.text).toContain(`🌐 Опубликовано: ${PUBLIC_API_URL}/l/${landing.slug}`);
    expect(released.text).toContain(
      `Ссылка для рекламы: ${PUBLIC_API_URL}/l/${landing.slug}?utm_source=reddit&utm_medium=cpc&utm_campaign=launch`,
    );
    const asset = await current();
    expect(asset).toMatchObject({
      status: 'released',
      releaseChecks: ['crash_test', 'no_blockers'],
    });
    expect(asset.releasedAt).toBeDefined();
    const history = await db.events.history({ type: 'media_asset', id: asset.id });
    expect(history.at(-1)?.actor).toEqual({ type: 'owner', id: `telegram:${String(OWNER_TG)}` });
    // The same press delivered again changes nothing.
    expect((await press(`ma:yg:${landing.id}:${String(landing.version)}`)).text).toContain(
      'Карточка устарела',
    );
  });

  it('serves the public page; the funnel counts only while the test runs', async () => {
    const page = await visit(`/l/${landing.slug}?utm_source=reddit&utm_campaign=t1&utm_term=%20`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('set-cookie')).toBeNull();
    const html = await page.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`href="/l/${landing.slug}/go?utm_source=reddit&amp;utm_campaign=t1"`);
    expect(html).toContain('No cookies. This page counts visits and button presses');
    // The launch is approved but the test has not started: the crash test is not counted.
    expect(await trackerEvents()).toEqual([]);

    const [, card] = await command('experiments');
    expect(card?.text).toContain(`🎨 Лендинг: 🌐 опубликован — /l/${landing.slug}`);
    const go = await press(`ex:yg:${experiment.id}:${String(experiment.version)}`);
    expect(go.text).toContain('▶️ Тест идёт.');
  });

  it('counts a person once per stage, not robots, prefetches or HEAD requests', async () => {
    const path = `/l/${landing.slug}?utm_source=reddit`;
    expect((await visit(path)).status).toBe(200);
    expect((await visit(path)).status).toBe(200);
    await visit(path, { 'x-forwarded-for': '203.0.113.7' });
    await visit(path, { 'user-agent': 'TelegramBot (like TwitterBot)' });
    await visit(path, { 'sec-purpose': 'prefetch' });
    expect((await visit(path, {}, 'HEAD')).status).toBe(200);
    const click = await visit(`/l/${landing.slug}/go?utm_source=reddit`);
    expect(click.status).toBe(303);
    expect(click.headers.get('location')).toBe(`/l/${landing.slug}/thanks`);
    const thanks = await visit(`/l/${landing.slug}/thanks`);
    expect(thanks.status).toBe(200);
    expect(await thanks.text()).toContain('Nothing was collected from you.');

    expect(await trackerEvents()).toEqual([
      { stage: 'attention', utm_source: 'reddit', channel: 'Reddit ads', actor_id: 'site' },
      { stage: 'attention', utm_source: 'reddit', channel: 'Reddit ads', actor_id: 'site' },
      { stage: 'cta_click', utm_source: 'reddit', channel: 'Reddit ads', actor_id: 'site' },
    ]);
    const totals = await db.funnel.totals([experiment.id]);
    expect(totals.get(experiment.id)).toMatchObject({ attention: 2, cta_click: 1 });
  });

  it('does not take the page’s stages in /funnel twice', async () => {
    const [refused] = await command('funnel', '1 клики 5 внимание 40');
    expect(refused?.text).toContain(
      '⛔ внимание, клики CTA — у теста №1 их считают страница и /leads',
    );
    const [asked] = await command('funnel', '1 показы 1000 $5');
    expect(asked?.text).toContain('показы: 0 → 1000 (+1000)');
  });

  it('stops counting with the kill switch and without the counter’s access', async () => {
    const path = `/l/${landing.slug}`;
    await setKillSwitch(true);
    expect((await visit(path, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
    await setKillSwitch(false);
    const principal = await db.repositories.principals.getByActor(SITE_TRACKER);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      suspendPrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    expect((await visit(path, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200);
    expect(await trackerEvents()).toHaveLength(3);
    // The database refuses a tracker event of an inactive integration too.
    const write = db.funnel.record(
      [
        {
          experimentId: experiment.id,
          hypothesisId: experiment.hypothesisId,
          stage: 'attention',
          quantity: 1,
          channel: 'Reddit ads',
          utm: {},
          occurredAt: now(),
          source: 'tracker',
        },
      ],
      SITE_TRACKER,
    );
    await expect(write).rejects.toMatchObject({ code: 'permission_denied' });
    // An integration never reports owner numbers.
    const report = db.funnel.record(
      [
        {
          experimentId: experiment.id,
          hypothesisId: experiment.hypothesisId,
          stage: 'payment',
          quantity: 1,
          channel: 'Reddit ads',
          utm: {},
          occurredAt: now(),
          source: 'owner_report',
        },
      ],
      SITE_TRACKER,
    );
    await expect(report).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('closes the page when the test ends; the database keeps releases confirmed', async () => {
    const running = await db.repositories.experiments.getById(experiment.id);
    if (running === undefined) throw new Error('no experiment');
    const stop = await press(`ex:ys:${running.id}:${String(running.version)}`);
    expect(stop.text).toContain('⏹');
    const ended = await visit(`/l/${landing.slug}`);
    expect(ended.status).toBe(410);
    expect(await ended.text()).toContain('This test has ended');
    expect((await visit(`/l/${landing.slug}/go`)).status).toBe(410);
    expect((await visit('/l/not-a-released-page')).status).toBe(404);
    expect((await visit(`/l/${landing.slug}`, {}, 'POST')).status).toBe(405);

    // A release without every confirmation of the owner does not pass the database.
    const error = await db.sql`
      update media_assets set release_checks = '{crash_test}', version = version + 1
      where id = ${landing.id}
    `.then(
      () => undefined,
      (caught: unknown) => translateError(caught),
    );
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect(error).toMatchObject({ constraint: 'media_assets_release_confirmed' });
    // Neither visitors nor the private preview link reach the logs.
    const logged = JSON.stringify(records);
    expect(logged).not.toContain(BROWSER);
    expect(logged).not.toContain('203.0.113.7');
    expect(logged).not.toContain(landing.previewToken);
  });
});
