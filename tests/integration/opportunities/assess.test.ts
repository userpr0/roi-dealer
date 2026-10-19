import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { opportunityAnalystAgent, runAgent } from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import {
  buildDigest,
  ensureAccessRequest,
  NO_OPPORTUNITIES_TEXT,
  opportunitiesText,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  addSignalToPain,
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  createEvidence,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  painIdSchema,
  pauseSystem,
  resumeSystem,
  signalIdSchema,
  sourceIdSchema,
  toTimestamp,
  type Evidence,
  type Pain,
  type Signal,
  type Source,
  type SystemControl,
} from '@roi-dealer/domain';
import {
  assessPains,
  frameOpportunityTask,
  OPPORTUNITY_ANALYST,
  OPPORTUNITY_TASKS,
  type FrameOpportunityOutput,
} from '@roi-dealer/opportunities';
import { uuidv7 } from '@roi-dealer/shared';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let runtime: AiRuntime;
let forum: Source;
const { logger, records } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());

const frame = (overrides: Partial<FrameOpportunityOutput> = {}): FrameOpportunityOutput => ({
  title: 'Payouts that reconcile themselves for small agencies',
  summary: 'Small agencies spend hours matching payouts with their books.',
  icp: 'Agencies with 2–20 people',
  problem: 'Payouts do not match the books',
  change: 'Payouts are matched automatically every day',
  measurableResult: 'Six hours a week saved',
  buyer: 'business',
  recurring: true,
  urgency: 'medium',
  serviceHeavy: false,
  paymentQuotes: [],
  pricingHypothesis: '$49 a month',
  ...overrides,
});

const GOLDEN = new Map(
  frameOpportunityTask.evalCases.map((c) => [frameOpportunityTask.render(c.input), c.expected]),
);
/** What the fake model answers for a pain outside the golden set, by its title. */
const answers = new Map<string, FrameOpportunityOutput>();

function oracle(request: FakeAiRequest) {
  if (request.instructions !== frameOpportunityTask.instructions) return { status: 400 };
  const expected = GOLDEN.get(request.prompt);
  if (expected !== undefined) {
    return {
      text: JSON.stringify(
        frame({
          buyer: expected.buyer,
          recurring: expected.recurring,
          paymentQuotes: expected.paying ? [(expected.excerpts.at(-1) ?? '').slice(0, 40)] : [],
        }),
      ),
    };
  }
  const title = /^Pain: (.*)$/m.exec(request.prompt)?.[1] ?? '';
  return { text: JSON.stringify(answers.get(title) ?? frame({ problem: '' })) };
}

async function evidenceOf(text: string): Promise<Evidence> {
  const evidence = createEvidence(
    { sourceId: forum.id, kind: 'post', excerpt: text, observedAt: now() },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  return evidence;
}

async function signalOf(evidence: Evidence): Promise<Signal> {
  const signal = createSignal(
    {
      title: 'A pain',
      summary: 'A pain',
      evidenceIds: [evidence.id],
      markets: ['US'],
      strength: 'moderate',
    },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.signals.insert(signal);
  return signal;
}

/** A pain with one signal per text, created the way the pain analyst does. */
async function painOf(title: string, texts: readonly string[], severity = 3): Promise<Pain> {
  const signals: Signal[] = [];
  for (const text of texts) signals.push(await signalOf(await evidenceOf(text)));
  const [first, ...rest] = signals;
  if (first === undefined) throw new Error('no texts');
  let pain = createPain(
    {
      title,
      description: title,
      audience: 'Small agencies',
      desiredOutcome: 'Solve it',
      severity,
      frequency: 'rare',
      markets: ['US'],
      signalIds: [first.id],
      evidenceIds: first.evidenceIds,
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  for (const signal of rest) {
    pain = addSignalToPain(pain, signal, { actor: SYSTEM, at: now() });
    await db.repositories.pains.update(pain, SYSTEM);
  }
  return pain;
}

async function assessment(pain: Pain) {
  return db.sql<{ outcome: string; score: number | null; opportunity_id: string | null }[]>`
    select outcome, score, opportunity_id from opportunity_assessments
    where pain_id = ${pain.id} order by pain_version
  `;
}

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = (await db.repositories.systemControls.getById(
    AUTOMATION_CONTROL_ID,
  )) as SystemControl;
  const next = paused
    ? pauseSystem(control, 'Тест стоп-крана', { actor: OWNER, at: now() })
    : resumeSystem(control, { actor: OWNER, at: now() });
  await db.repositories.systemControls.update(next, OWNER);
}

const deps = () => ({ database: db, logger, runtime });

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [createAnthropicProvider({ apiKey: 'sk-ant-opps-test', baseUrl: claude.baseUrl })],
    timeoutMs: 5_000,
  });
  forum = createSource(sourceData({ name: 'Test forum' }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(forum);
});

afterAll(async () => {
  await claude.close();
  await test.drop();
});

beforeEach(() => {
  claude.answer(oracle);
});

describe('the opportunity analyst needs the owner’s grant and a passing eval', () => {
  it('asks in /decisions and calls no model before the grant', async () => {
    await expect(assessPains(deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'access_missing',
    });
    await expect(
      runAgent(opportunityAnalystAgent(), {
        ...deps(),
        ensureAccess: ensureAccessRequest,
        now: Date.now,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('no_access');
    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Агент возможностей');
    expect(claude.calls).toEqual([]);

    const principal = await db.repositories.principals.getByActor(OPPORTUNITY_ANALYST);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    const [report] = await runtime.evaluateMissing(OPPORTUNITY_TASKS);
    expect(report?.score.passed).toBe(true);
  });
});

describe('from pains to draft opportunities (PHASE 07)', () => {
  let payouts: Pain;
  let pickups: Pain;
  let single: Pain;
  let empty: Pain;

  it('scores pains seen twice, verifies money quotes and drafts the good ones', async () => {
    payouts = await painOf('Agencies reconcile payouts by hand', [
      'Reconciling Stripe payouts takes our accountant 6 hours a week.',
      'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
    ]);
    pickups = await painOf(
      'Parents struggle to coordinate school pickups',
      ['Every week I text five parents about pickups.', 'School pickups are chaos for us.'],
      2,
    );
    single = await painOf('Only one complaint so far', ['Just one post about this.']);
    empty = await painOf('The model answers nothing useful', [
      'First post about it.',
      'Second post about it.',
    ]);
    answers.set(
      payouts.title,
      frame({
        icp: '',
        paymentQuotes: ['We pay a bookkeeper $400 a month', 'We lose a million dollars a year'],
      }),
    );
    answers.set(pickups.title, frame({ buyer: 'consumer', recurring: true, urgency: 'low' }));

    await expect(assessPains(deps())).resolves.toEqual({
      status: 'assessed',
      assessed: 3,
      opportunities: 1,
      belowThreshold: 1,
      stoppedBy: undefined,
    });

    const [drafted] = await assessment(payouts);
    expect(drafted).toMatchObject({ outcome: 'opportunity', score: 62 });
    const opportunity = await db.repositories.opportunities.getById(
      drafted?.opportunity_id as never,
    );
    expect(opportunity).toMatchObject({
      status: 'draft',
      painIds: [payouts.id],
      icp: 'Small agencies',
      markets: ['US'],
      businessModel: { model: 'subscription', pricingHypothesis: '$49 a month' },
      valueProposition: { proof: '"We pay a bookkeeper $400 a month"' },
      createdBy: OPPORTUNITY_ANALYST,
    });
    expect(opportunity?.summary).toContain('Score 62/100');

    // The second signal raised the severity to 3: 12.5 + 10 + 7.5 + 0 + 10 + 5.
    expect(await assessment(pickups)).toMatchObject([{ outcome: 'below_threshold', score: 45 }]);
    expect(await assessment(empty)).toMatchObject([{ outcome: 'rejected', score: null }]);
    expect(await assessment(single)).toEqual([]);

    // Every version is assessed once: nothing new, nothing spent.
    const calls = claude.calls.length;
    await expect(assessPains(deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'nothing_new',
    });
    expect(claude.calls).toHaveLength(calls);
  });

  it('assesses a pain again when it grows, and only then', async () => {
    const grown = addSignalToPain(
      pickups,
      await signalOf(await evidenceOf('We spend $150 a month on a pickup app that nobody uses.')),
      { actor: SYSTEM, at: now() },
    );
    await db.repositories.pains.update(grown, SYSTEM);
    answers.set(
      pickups.title,
      frame({
        buyer: 'consumer',
        urgency: 'high',
        paymentQuotes: ['We spend $150 a month on a pickup app'],
      }),
    );
    await expect(assessPains(deps())).resolves.toMatchObject({ assessed: 1, opportunities: 1 });
    expect((await assessment(pickups)).map((row) => row.outcome)).toEqual([
      'below_threshold',
      'opportunity',
    ]);
  });
});

describe('stops without wasting budget', () => {
  it('the kill switch stops the run before any call', async () => {
    await painOf('Waiting while paused', ['Paused one.', 'Paused two.']);
    const calls = claude.calls.length;
    await setKillSwitch(true);
    try {
      await expect(assessPains(deps())).rejects.toMatchObject({ code: 'automation_paused' });
    } finally {
      await setKillSwitch(false);
    }
    expect(claude.calls).toHaveLength(calls);
  });

  it('no usable model stops the run; a failure of every model is recorded once', async () => {
    const offline = createAiRuntime({ database: db, logger, providers: [] });
    await expect(assessPains({ database: db, logger, runtime: offline })).resolves.toMatchObject({
      assessed: 0,
      stoppedBy: 'unavailable',
    });
    await painOf('Second waiting pain', ['Waiting one.', 'Waiting two.']);
    claude.answer(() => ({ status: 500 }));
    await expect(assessPains(deps())).resolves.toMatchObject({
      assessed: 1,
      stoppedBy: 'failed',
    });
    const outcomes = await db.sql<{ outcome: string }[]>`
      select outcome from opportunity_assessments where outcome = 'failed'
    `;
    expect(outcomes).toHaveLength(1);
  });
});

describe('the owner sees what was found', () => {
  it('/opportunities lists drafts with score, model and pain; the digest counts them', async () => {
    const text = await opportunitiesText(db.repositories, db.opportunityAssessments, db.judgements);
    expect(text).not.toBe(NO_OPPORTUNITIES_TEXT);
    expect(text).toMatch(/^💡 Возможности · открытых: 2/);
    expect(text).toContain('1. Payouts that reconcile themselves for small agencies — 62/100');
    expect(text).toContain('Модель: подписка · рынки: US · черновик');
    expect(text).toContain(
      'Оценка: частота 12.5 · тяжесть 10 · источники 7.5 · готовность платить 12 · рынок 10 · покупатель 10',
    );
    expect(text).toContain('Боль: Agencies reconcile payouts by hand');

    expect(await buildDigest(db, Date.now())).toContain(
      '💡 Новых возможностей за сутки: 2 → /opportunities',
    );
  });

  it('keeps the texts of the posts out of the logs', () => {
    const logs = JSON.stringify(records);
    for (const secret of ['$400 a month', 'pickup app']) expect(logs).not.toContain(secret);
  });
});
