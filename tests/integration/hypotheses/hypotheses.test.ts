import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TASKS,
  designHypothesesTask,
  HYPOTHESIS_DESIGNER,
  hypothesisDesignerAgent,
  runAgent,
  type DesignHypothesesOutput,
} from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import {
  createDecisionCardNotifier,
  ensureAccessRequest,
  hypothesesText,
  NO_HYPOTHESES_TEXT,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  applyOpportunityDecision,
  approvePrincipal,
  createDecision,
  createEvidence,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  opportunityIdSchema,
  painIdSchema,
  signalIdSchema,
  sourceIdSchema,
  submitOpportunityForReview,
  toTimestamp,
  type Opportunity,
  type Source,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { agentGolden, perfectHypothesesAnswer } from '../../support/agent-answers.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let runtime: AiRuntime;
let forum: Source;
const { logger, records } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());
const golden = agentGolden();

/** The fake model's answers outside the golden set, one per call. */
let answers: DesignHypothesesOutput[] = [];

function oracle(request: FakeAiRequest) {
  if (request.instructions !== designHypothesesTask.instructions) {
    return { text: JSON.stringify({ queries: [] }) };
  }
  const expected = golden.hypotheses.get(request.prompt);
  if (expected !== undefined) return { text: JSON.stringify(perfectHypothesesAnswer(expected)) };
  const next =
    answers.shift() ?? perfectHypothesesAnswer({ markets: ['US'], audience: 'Freelancers' });
  return { text: JSON.stringify(next) };
}

const run = () =>
  runAgent(hypothesisDesignerAgent(), {
    database: db,
    logger,
    runtime,
    ensureAccess: ensureAccessRequest,
    now: Date.now,
    signal: new AbortController().signal,
  });

/** An opportunity the owner approved on its decision card (PHASE 12). */
async function approved(title: string): Promise<Opportunity> {
  const evidence = createEvidence(
    {
      sourceId: forum.id,
      kind: 'post',
      excerpt: `${title}: we pay $300 a month.`,
      observedAt: now(),
    },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  const signal = createSignal(
    { title, summary: title, evidenceIds: [evidence.id], markets: ['US'], strength: 'moderate' },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.signals.insert(signal);
  const pain = createPain(
    {
      title,
      description: title,
      audience: 'Freelancers',
      desiredOutcome: 'Paid on time',
      severity: 3,
      frequency: 'rare',
      markets: ['US'],
      signalIds: [signal.id],
      evidenceIds: [evidence.id],
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  const draft = createOpportunity(
    {
      title,
      summary: `${title}.`,
      painIds: [pain.id],
      icp: 'Freelancers',
      markets: ['US'],
      valueProposition: {
        problem: 'Clients pay late',
        change: 'Reminders run on their own',
        measurableResult: 'A day a month back',
      },
      businessModel: { model: 'subscription', pricingHypothesis: '$12 a month' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.opportunities.insert(draft);
  const review = submitOpportunityForReview(draft, { actor: SYSTEM, at: now() });
  await db.repositories.opportunities.update(review, SYSTEM);
  const decision = createDecision(
    {
      subject: { type: 'opportunity', id: review.id },
      outcome: 'approve',
      rationale: 'Owner decision: approve.',
      evidenceIds: [evidence.id],
    },
    { id: decisionIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
  );
  await db.repositories.decisions.insert(decision);
  const next = applyOpportunityDecision(review, decision);
  await db.repositories.opportunities.update(next, OWNER);
  return next;
}

const work = () =>
  db.sql<{ outcome: string; result: Record<string, unknown> }[]>`
    select outcome, result from agent_work where agent = 'hypothesis-designer' order by id
  `;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [createAnthropicProvider({ apiKey: 'sk-ant-hyp-test', baseUrl: claude.baseUrl })],
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
  answers = [];
});

describe('the hypothesis agent (PHASE 14)', () => {
  it('asks for access first, then runs only after its eval', async () => {
    await expect(run()).resolves.toBe('no_access');
    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Агент гипотез');
    const principal = await db.repositories.principals.getByActor(HYPOTHESIS_DESIGNER);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    const reports = await runtime.evaluateMissing(
      AGENT_TASKS.filter((task) => task.name === 'design-hypotheses'),
    );
    expect(reports.map((report) => [report.task, report.score.passed])).toEqual([
      ['design-hypotheses', true],
    ]);
    expect(await hypothesesText(db.repositories)).toBe(NO_HYPOTHESES_TEXT);
  });

  it('proposes five checked hypotheses for an approved opportunity, once', async () => {
    const opportunity = await approved('Invoices that get paid');
    const calls = claude.calls.length;
    await expect(run()).resolves.toBe('done');
    expect(claude.calls.length - calls).toBe(1);
    const hypotheses = await db.repositories.hypotheses.listByOpportunities([opportunity.id]);
    expect(hypotheses).toHaveLength(5);
    expect(hypotheses.every((item) => item.status === 'proposed')).toBe(true);
    expect(hypotheses.every((item) => item.createdBy.id === 'hypothesis-designer')).toBe(true);
    expect(new Set(hypotheses.map((item) => item.validationMethod)).size).toBe(5);
    expect((await work()).at(-1)).toMatchObject({
      outcome: 'done',
      result: { hypotheses: 5, attempts: 1 },
    });
    await expect(run()).resolves.toBe('idle');

    const text = await hypothesesText(db.repositories);
    expect(text).toContain('«Invoices that get paid» — гипотез 5');
    expect(text).toContain('1. лендинг · Freelancers (US) · $10.00 · канал: Reddit ads');
    expect(text).toContain('Бюджет $50.00, stop-loss $20.00 · успех: заявки ≥ 20');
    expect(text).toContain('успех: заявки / клики CTA ≥ 10 %');
  });

  it('asks once for a fix with the issues, then gives up', async () => {
    const fixed = await approved('Rent that arrives on time');
    const good = perfectHypothesesAnswer({ markets: ['US'], audience: 'Landlords' });
    answers = [{ hypotheses: good.hypotheses.slice(0, 3) }, good];
    await expect(run()).resolves.toBe('done');
    expect(claude.calls.at(-1)?.prompt).toContain(
      'Fix these issues of your previous answer: expected 5 hypotheses, got 3',
    );
    expect(await db.repositories.hypotheses.listByOpportunities([fixed.id])).toHaveLength(5);
    expect((await work()).at(-1)).toMatchObject({ outcome: 'done', result: { attempts: 2 } });

    const hopeless = await approved('Plants that water themselves');
    const tooDear = { hypotheses: good.hypotheses.map((item) => ({ ...item, budgetUsd: 90 })) };
    answers = [tooDear, tooDear];
    await expect(run()).resolves.toBe('done');
    expect(await db.repositories.hypotheses.listByOpportunities([hopeless.id])).toEqual([]);
    expect((await work()).at(-1)).toMatchObject({ outcome: 'rejected', result: { attempts: 2 } });
  });

  it('tells the owner once per opportunity that the hypotheses are ready', async () => {
    const sent: string[] = [];
    const notifier = createDecisionCardNotifier({
      database: db,
      logger,
      deliver: (text, keyboard) => {
        expect(keyboard).toBeUndefined();
        sent.push(text);
        return Promise.resolve();
      },
    });
    await expect(notifier.runOnce()).resolves.toBe(2);
    expect(sent.sort()).toEqual([
      '🧪 Готовы 5 гипотез проверки для «Invoices that get paid» → /hypotheses',
      '🧪 Готовы 5 гипотез проверки для «Rent that arrives on time» → /hypotheses',
    ]);
    await expect(notifier.runOnce()).resolves.toBe(0);
    expect(JSON.stringify(records)).not.toContain('we pay $300');
  });
});
