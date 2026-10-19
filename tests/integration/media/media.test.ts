import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { landingWriterAgent, LANDING_WRITER, runAgent } from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import {
  createCommandCenter,
  createDecisionCardNotifier,
  ensureAccessRequest,
  type CommandCenter,
} from '@roi-dealer/command-center';
import { ConstraintViolationError, type Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  changeHypothesisStatus,
  createExperiment,
  createHypothesis,
  createMediaAsset,
  experimentIdSchema,
  funnelMetric,
  hypothesisIdSchema,
  mediaAssetIdSchema,
  planExperiment,
  toTimestamp,
  usd,
  type Experiment,
  type MediaAsset,
  type Opportunity,
} from '@roi-dealer/domain';
import {
  MEDIA_TASKS,
  newPreviewToken,
  writeLandingTask,
  type WriteLandingOutput,
} from '@roi-dealer/media';
import { createHealthRegistry } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import { previewPage } from '@roi-dealer/site';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { createRouter } from '../../../apps/api/src/router.js';
import { startApiServer, type ApiServer } from '../../../apps/api/src/server.js';
import { approvedOpportunity } from '../../support/cycle.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { hypothesisData, OWNER, SYSTEM } from '../../support/domain.js';
import { startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';
import { landingGolden, perfectLandingAnswer } from '../../support/media-answers.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let runtime: AiRuntime;
let cc: CommandCenter;
let server: ApiServer;
let api: string;
let opportunity: Opportunity;
let experiment: Experiment;
const { logger, records } = createCapturingLogger('worker');
const OWNER_TG = 9191;
const PUBLIC_API_URL = 'https://api.example.test';
const now = () => toTimestamp(new Date());
const golden = landingGolden();
let update = 3_500;

interface Message {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

/** The fake model's answers outside the golden set, one per call. */
let answers: WriteLandingOutput[] = [];

/** A correct page for the test's opportunity. */
function pageForTest(headline?: string): WriteLandingOutput {
  return perfectLandingAnswer(
    {
      opportunity: {
        title: opportunity.title,
        icp: opportunity.icp,
        problem: opportunity.valueProposition.problem,
        change: opportunity.valueProposition.change,
        measurableResult: opportunity.valueProposition.measurableResult,
      },
      hypothesis: {
        audience: 'Freelancers in the US',
        offer: 'Automatic invoice reminders, $12 a month',
        priceUsd: 12,
        channel: 'Reddit r/freelance',
        creative: 'Get paid on time',
        cta: 'Join the waitlist',
        method: 'waitlist',
      },
    },
    headline === undefined ? {} : { headline },
  );
}

function oracle(request: FakeAiRequest) {
  if (request.instructions !== writeLandingTask.instructions) return { text: '{}' };
  const input = golden.get(request.prompt);
  if (input !== undefined) return { text: JSON.stringify(perfectLandingAnswer(input)) };
  return { text: JSON.stringify(answers.shift() ?? pageForTest()) };
}

const run = () =>
  runAgent(landingWriterAgent(), {
    database: db,
    logger,
    runtime,
    ensureAccess: ensureAccessRequest,
    now: Date.now,
    signal: new AbortController().signal,
  });

async function command(name: string): Promise<Message[]> {
  const replies: Message[] = [];
  const handler = cc.commands.find((item) => item.name === name)?.handler;
  if (handler === undefined) throw new Error(`no /${name}`);
  await handler({
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    args: '',
    logger,
    reply: (text, keyboard) => {
      replies.push({ text, keyboard });
      return Promise.resolve();
    },
  });
  return replies;
}

const texts = async (name: string) => (await command(name)).map((item) => item.text).join('\n');

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

/** A selected hypothesis tested with a waitlist page: its plan has the `landing` artifact. */
async function plannedLandingTest(target: Opportunity): Promise<Experiment> {
  const proposed = createHypothesis(
    hypothesisData(target.id, {
      validationMethod: 'waitlist',
      price: usd(1_200),
      offer: 'Automatic invoice reminders, $12 a month',
      successMetric: funnelMetric({ stage: 'lead' }, 20),
      budget: usd(5_000),
      stopLoss: usd(2_000),
    }),
    { id: hypothesisIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.hypotheses.insert(proposed);
  const selected = changeHypothesisStatus(proposed, 'selected', { actor: OWNER, at: now() });
  await db.repositories.hypotheses.update(selected, OWNER);
  const planned = createExperiment(planExperiment(selected), selected, {
    id: experimentIdSchema.parse(uuidv7()),
    actor: OWNER,
    at: now(),
  });
  await db.repositories.experiments.insert(planned);
  return planned;
}

async function landingsOf(target: Experiment): Promise<MediaAsset[]> {
  return db.repositories.mediaAssets.listByExperiments([target.id]);
}

/** Sends what the notifier would send now; returns the landing cards. */
async function cards(): Promise<Message[]> {
  const sent: Message[] = [];
  const notifier = createDecisionCardNotifier({
    database: db,
    logger,
    deliver: (text, keyboard) => {
      sent.push({ text, keyboard });
      return Promise.resolve();
    },
    publicApiUrl: PUBLIC_API_URL,
  });
  await notifier.runOnce();
  return sent.filter((item) => item.text.startsWith('🎨'));
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [createAnthropicProvider({ apiKey: 'sk-ant-media-test', baseUrl: claude.baseUrl })],
    timeoutMs: 5_000,
  });
  cc = createCommandCenter({
    database: db,
    logger,
    deliverDigest: () => Promise.resolve(),
    publicApiUrl: PUBLIC_API_URL,
  });
  ({ opportunity } = await approvedOpportunity(db, 'Invoices that get paid'));
  experiment = await plannedLandingTest(opportunity);
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: createRouter({
      health: createHealthRegistry({ service: 'api' }),
      site: { preview: (token) => previewPage(db, token) },
    }),
    logger,
  });
  api = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.close();
  await claude.close();
  await test.drop();
});

beforeEach(() => {
  claude.answer(oracle);
  answers = [];
});

describe('the landing writer (PHASE 19a)', () => {
  it('asks for access first, then runs only after its eval', async () => {
    await expect(run()).resolves.toBe('no_access');
    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Автор лендингов');
    const principal = await db.repositories.principals.getByActor(LANDING_WRITER);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    const reports = await runtime.evaluateMissing(MEDIA_TASKS);
    expect(reports.map((report) => [report.task, report.score.passed])).toEqual([
      ['write-landing', true],
    ]);
  });

  it('writes a checked draft for a test that needs a landing, once', async () => {
    const calls = claude.calls.length;
    await expect(run()).resolves.toBe('done');
    expect(claude.calls.length - calls).toBe(1);
    const [landing] = await landingsOf(experiment);
    expect(landing).toMatchObject({
      status: 'draft',
      kind: 'landing',
      createdBy: LANDING_WRITER,
      content: { price: usd(1_200), disclosure: 'in_development', cta: 'Join the waitlist' },
    });
    expect(landing?.slug).toMatch(/^invoices-that-get-paid-[a-f0-9]{8}$/);
    await expect(run()).resolves.toBe('idle');
  });

  it('sends the card once with the preview link; the test card shows the state', async () => {
    const [landing] = await landingsOf(experiment);
    if (landing === undefined) throw new Error('no landing');
    const [card] = await cards();
    expect(card?.text).toContain('🎨 Лендинг для теста №1 «Invoices that get paid»');
    expect(card?.text).toContain('Цена: $12.00 / month · пометка «в разработке, оставьте почту»');
    expect(card?.text).toContain(`Предпросмотр: ${PUBLIC_API_URL}/p/${landing.previewToken}`);
    expect(buttons(card)).toEqual([`ma:a:${landing.id}:1`, `ma:r:${landing.id}:1`]);
    expect(await cards()).toEqual([]);
    expect(await texts('experiments')).toContain('🎨 Лендинг: ждёт вашей проверки: ✅ или ❌');
  });

  it('serves the private preview: static, escaped, with strict headers', async () => {
    const [landing] = await landingsOf(experiment);
    if (landing === undefined) throw new Error('no landing');
    const response = await fetch(`${api}/p/${landing.previewToken}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const html = await response.text();
    expect(html).toContain('Preview — this page is not public yet.');
    expect(html).toContain('$12.00 / month');
    expect(html).not.toMatch(/<script/i);
    expect((await fetch(`${api}/p/${newPreviewToken()}`)).status).toBe(404);
    expect((await fetch(`${api}/p/not-a-token`)).status).toBe(404);
    expect((await fetch(`${api}/p/${landing.previewToken}`, { method: 'POST' })).status).toBe(405);
  });

  it('rewrites a rejected page with a different headline; the owner approves it', async () => {
    const [first] = await landingsOf(experiment);
    if (first === undefined) throw new Error('no landing');
    expect((await press(`ma:r:${first.id}:1`)).text).toContain(
      '❓ Отклонить? Агент напишет новый вариант (осталось переписываний: 2).',
    );
    expect((await press(`ma:yr:${first.id}:1`)).text).toContain('❌ Отклонено.');
    expect((await fetch(`${api}/p/${first.previewToken}`)).status).toBe(404);

    // The first answer invents proof: code asks once for a fix.
    const good = pageForTest('Get paid on time, every time');
    answers = [{ ...good, headline: 'Trusted by 2,000+ freelancers' }, good];
    await expect(run()).resolves.toBe('done');
    const [rewrite, fix] = claude.calls.slice(-2);
    expect(rewrite?.prompt).toContain(
      `The owner rejected a page with the headline: ${first.content.headline}`,
    );
    expect(fix?.prompt).toContain('Fix these issues of your previous answer: headline: no');
    const second = (await landingsOf(experiment)).at(-1);
    expect(second).toMatchObject({
      status: 'draft',
      content: { headline: 'Get paid on time, every time' },
    });
    if (second === undefined) throw new Error('no rewrite');

    const [card] = await cards();
    expect(buttons(card)).toEqual([`ma:a:${second.id}:1`, `ma:r:${second.id}:1`]);
    expect((await press(`ma:ya:${second.id}:1`)).text).toContain('✅ Одобрено.');
    expect((await db.repositories.mediaAssets.getById(second.id))?.status).toBe('approved');
    // A stale card changes nothing.
    expect((await press(`ma:yr:${second.id}:1`)).text).toContain('Карточка устарела');
    const history = await db.events.history({ type: 'media_asset', id: second.id });
    expect(history.at(-1)?.actor).toEqual({ type: 'owner', id: `telegram:${String(OWNER_TG)}` });
    expect(await texts('experiments')).toContain('🎨 Лендинг: ✅ одобрен');
    // Cost per Approved Asset in /economics.
    expect(await texts('economics')).toMatch(
      /🎨 Лендинги: AI \$\d+\.\d{2} · одобрено 1 · \$\d+\.\d{2} за одобренный/,
    );
  });

  it('stops after two rewrites; the database keeps one live landing per test', async () => {
    const other = await plannedLandingTest(opportunity);
    for (let round = 0; round < 3; round += 1) {
      await expect(run()).resolves.toBe('done');
      const draft = (await landingsOf(other)).at(-1);
      if (draft?.status !== 'draft') throw new Error('no draft');
      await press(`ma:yr:${draft.id}:${String(draft.version)}`);
    }
    expect((await landingsOf(other)).map((item) => item.status)).toEqual([
      'rejected',
      'rejected',
      'rejected',
    ]);
    await expect(run()).resolves.toBe('idle');

    const [approved] = (await landingsOf(experiment)).filter((item) => item.status === 'approved');
    if (approved === undefined) throw new Error('no approved landing');
    const second = createMediaAsset(
      {
        kind: 'landing',
        experimentId: experiment.id,
        hypothesisId: experiment.hypothesisId,
        opportunityId: experiment.opportunityId,
        content: approved.content,
        slug: 'invoices-second-live-page',
        previewToken: newPreviewToken(),
      },
      { id: mediaAssetIdSchema.parse(uuidv7()), actor: LANDING_WRITER, at: now() },
    );
    const error = await db.repositories.mediaAssets.insert(second).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).constraint).toBe('media_assets_one_live');
    // Texts of the pages are not logged.
    expect(JSON.stringify(records)).not.toContain('Get paid on time, every time');
  });
});
