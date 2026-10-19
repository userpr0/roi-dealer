import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCommandCenter,
  createDecisionCardNotifier,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import { AUTO_PAUSE_PREFIX, runSpendGuard } from '@roi-dealer/economics';
import {
  applyOpportunityDecision,
  approvalRequestIdSchema,
  approveExperiment,
  AUTOMATION_CONTROL_ID,
  changeHypothesisStatus,
  confirmHonestChecks,
  createApprovalRequest,
  createDecision,
  createEvidence,
  createExperiment,
  createHypothesis,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  experimentIdSchema,
  experimentTotalBudget,
  funnelMetric,
  hypothesisIdSchema,
  opportunityIdSchema,
  painIdSchema,
  planExperiment,
  recordRevenueEntry,
  requestExperimentApproval,
  resolveApprovalRequest,
  resumeSystem,
  revenueEntryIdSchema,
  signalIdSchema,
  sourceIdSchema,
  startExperiment,
  submitOpportunityForReview,
  toTimestamp,
  usd,
  type Experiment,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { AGENT, hypothesisData, OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let experiment: Experiment;
const { logger, records } = createCapturingLogger('bot');
const now = () => toTimestamp(new Date());
const OWNER_TG = 6161;
let update = 900;
const DAY_MS = 86_400_000;

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

async function press(data: string): Promise<string> {
  const edits: string[] = [];
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
    edit: (text) => {
      edits.push(text);
      return Promise.resolve();
    },
  };
  await handler(context);
  return edits.at(-1) ?? '';
}

/** Runs a command that asks for confirmation and confirms it. */
async function confirmed(
  name: string,
  args: string,
): Promise<{ question: string; result: string }> {
  const [question] = await run(name, args);
  const yes = (question?.keyboard ?? []).flat().find((item) => item.callback_data.includes(':y:'));
  return {
    question: question?.text ?? '',
    result: yes === undefined ? '' : await press(yes.callback_data),
  };
}

/** A landing-page test of an approved opportunity, launched and running (PHASE 12–15). */
async function runningTest(): Promise<Experiment> {
  const forum = createSource(sourceData({ name: 'Economics forum' }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(forum);
  const evidence = createEvidence(
    { sourceId: forum.id, kind: 'post', excerpt: 'Invoices are paid late.', observedAt: now() },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  const signal = createSignal(
    {
      title: 'Late invoices',
      summary: 'Late',
      evidenceIds: [evidence.id],
      markets: ['US'],
      strength: 'moderate',
    },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
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
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  const draft = createOpportunity(
    {
      title: 'Invoices that get paid',
      summary: 'Invoices that get paid.',
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
      rationale: 'Approve.',
      evidenceIds: [],
    },
    { id: decisionIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
  );
  await db.repositories.decisions.insert(decision);
  const approved = applyOpportunityDecision(review, decision);
  await db.repositories.opportunities.update(approved, OWNER);

  const proposed = createHypothesis(
    hypothesisData(approved.id, {
      successMetric: funnelMetric({ stage: 'lead' }, 20),
      budget: usd(5_000),
      stopLoss: usd(2_000),
      channel: 'Reddit ads',
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
  const checked = confirmHonestChecks(planned, selected, { actor: OWNER, at: now() });
  await db.repositories.experiments.update(checked, OWNER);
  const request = createApprovalRequest(
    {
      kind: 'experiment_launch',
      title: 'Launch',
      summary: 'Test budget',
      amount: experimentTotalBudget(checked),
      subject: { type: 'experiment', id: checked.id },
      expiresAt: toTimestamp(new Date(Date.now() + DAY_MS)),
    },
    { id: approvalRequestIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
  );
  await db.repositories.approvalRequests.insert(request);
  const launch = resolveApprovalRequest(
    request,
    { decision: 'approve' },
    { actor: OWNER, at: now() },
  );
  await db.repositories.approvalRequests.update(launch, OWNER);
  const awaiting = requestExperimentApproval(checked, request.id, { actor: OWNER, at: now() });
  await db.repositories.experiments.update(awaiting, OWNER);
  const ready = approveExperiment(awaiting, launch, { actor: OWNER, at: now() });
  await db.repositories.experiments.update(ready, OWNER);
  const started = startExperiment(ready, { actor: OWNER, at: now() });
  await db.repositories.experiments.update(started, OWNER);
  await db.repositories.hypotheses.update(
    changeHypothesisStatus(selected, 'testing', { actor: OWNER, at: now() }),
    OWNER,
  );
  return started;
}

async function aiCall(occurredAt: number, costMicroUsd: number): Promise<void> {
  await db.aiCalls.record({
    occurredAt: toTimestamp(new Date(occurredAt)),
    task: 'redact-names',
    taskVersion: 1,
    purpose: 'task',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    inputTokens: 100,
    outputTokens: 10,
    costMicroUsd,
    latencyMs: 100,
    outcome: 'ok',
    actorType: 'system',
    actorId: 'evidence-engine',
  });
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  cc = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  experiment = await runningTest();
});

afterAll(async () => {
  await test.drop();
});

describe('revenue and refunds of a test (PHASE 16)', () => {
  it('records payments with their customers and shows unit economics', async () => {
    const { question, result } = await confirmed('funnel', '1 оплаты 3 выручка 36 $10');
    expect(question).toContain('Выручка: $0.00 → $36.00 · клиентов +3');
    expect(result).toContain('📊 Записано.');
    const [entry] = await db.sql<{ kind: string; customers: number; amount_usd_cents: string }[]>`
      select kind, customers, amount_usd_cents::text from revenue_entries
      where experiment_id = ${experiment.id}
    `;
    expect(entry).toEqual({ kind: 'payment', customers: 3, amount_usd_cents: '3600' });
    const [card] = (await run('experiments')).slice(1);
    expect(card?.text).toContain('Выручка $36.00 · клиентов 3 · CAC $3.33 · ROI +260 %');
  });

  it('returns at most the money received; refunds do not count towards the stop-loss', async () => {
    const [tooMuch] = await run('funnel', '1 вернули 50');
    expect(tooMuch?.text).toContain('⛔ Вернуть можно не больше полученного: $36.00');
    const { result } = await confirmed('funnel', '1 вернули 12');
    expect(result).toContain('📊 Записано.');
    expect((await db.funnel.spent([experiment.id])).get(experiment.id)).toEqual(usd(1_000));
    expect((await db.economics.moneyFlows([experiment.id])).get(experiment.id)).toEqual({
      spend: usd(1_000),
      refunds: usd(1_200),
      payments: usd(3_600),
      preorders: usd(0),
      customers: 3,
    });
    expect((await db.repositories.experiments.getById(experiment.id))?.status).toBe('running');
    const [card] = (await run('experiments')).slice(1);
    expect(card?.text).toContain('возвраты $12.00 · CAC $3.33 · ROI +140 %');
  });
});

describe('/cost (PHASE 16, D-006)', () => {
  it('records a small cost against the month and its limit', async () => {
    const { question, result } = await confirmed('cost', '5 инфраструктура Railway октябрь');
    expect(question).toContain('Инфраструктура · $5.00 · «Railway октябрь»');
    expect(question).toContain('За месяц станет $5.00 из $20.00 (25 %).');
    expect(question).not.toContain('одобрение');
    expect(result).toBe('💸 Записано: Инфраструктура $5.00. Месяц — /economics.');
  });

  it('above $20 records the owner’s approval of the spend with it', async () => {
    const { question } = await confirmed('cost', '25 подрядчики Logo design');
    expect(question).toContain('Выше $20.00: подтверждение — ваше одобрение траты (D-006).');
    const [row] = await db.sql<{ status: string; kind: string; created_by_id: string }[]>`
      select a.status, a.kind, a.created_by_id from cost_entries c
      join approval_requests a on a.id = c.approval_request_id
      where c.category = 'vendor'
    `;
    expect(row).toEqual({
      status: 'approved',
      kind: 'spend',
      created_by_id: `telegram:${String(OWNER_TG)}`,
    });
    // Over the infrastructure limit: recorded as a fact, with a warning.
    const [over] = await run('cost', '16 инфраструктура Railway ноябрь');
    expect(over?.text).toContain('⚠️ Сверх лимита D-007 ($20.00)');
  });
});

describe('/economics (PHASE 16, D-014 п.11)', () => {
  it('shows the month against the limits, revenue and ROI from the ledgers', async () => {
    await aiCall(Date.now() - 1_000, 2_500_000);
    const [reply] = await run('economics');
    const text = reply?.text ?? '';
    expect(text).toContain('· Инфраструктура $5.00 из $20.00 (25 %)');
    expect(text).toContain('· AI $2.50 из $50.00 (5 %) · сегодня $2.50 из');
    expect(text).toContain('· Реклама тестов $10.00');
    expect(text).toContain('· Подрядчики $25.00');
    expect(text).toContain('Расходы: $42.50');
    expect(text).toContain('Тесты: 1 · потрачено $10.00 из одобренных $50.00');
    expect(text).toContain(
      'Выручка: оплаты $36.00 · предзаказы $0.00 · клиентов 3 · возвраты $12.00',
    );
    // (36 − 12) / 42.50
    expect(text).toContain('ROI системы: 56 %');
    expect(text).toContain('Проверенных гипотез пока нет.');
  });
});

describe('the revenue ledger in PostgreSQL (migration 0013)', () => {
  it('is append-only, needs its event and the owner', async () => {
    const update = await db.sql`update revenue_entries set customers = 9`.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(String(update)).toContain('UPDATE on revenue_entries is not allowed');
    const entry = recordRevenueEntry(
      {
        kind: 'payment',
        amount: usd(100),
        customers: 1,
        description: 'By an agent',
        receivedAt: now(),
        allocation: {},
      },
      { id: revenueEntryIdSchema.parse(uuidv7()), actor: AGENT, at: now() },
    );
    await expect(db.repositories.revenueEntries.insert(entry)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    const history = await db.events.list({ limit: 1_000 });
    expect(history.filter((event) => event.type === 'revenue_entry.created')).toHaveLength(1);
  });
});

describe('the spend guard (D-014 п.10)', () => {
  it('leaves a usual day alone and pauses at twice the seven-day average', async () => {
    const today = Date.now();
    for (let day = 1; day <= 7; day += 1) await aiCall(today - day * DAY_MS, 3_000_000);
    // Today so far: $2.50 — below twice the average ($6).
    expect(await runSpendGuard(db, today)).toMatchObject({
      outcome: 'normal',
      thresholdMicroUsd: 6_000_000,
    });
    await aiCall(today - 500, 4_000_000);
    expect(await runSpendGuard(db, today)).toMatchObject({
      outcome: 'paused',
      todayMicroUsd: 6_500_000,
    });
    const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    expect(control?.status).toBe('paused');
    expect(control?.reason?.startsWith(AUTO_PAUSE_PREFIX)).toBe(true);
    expect(control?.reason).toContain('автоматика потратила сегодня $6.50');
    expect(await runSpendGuard(db, today)).toMatchObject({ outcome: 'already_paused' });
    const [event] = (await db.events.list({ limit: 1_000 })).filter(
      (item) => item.type === 'system_control.updated',
    );
    expect(event?.actor).toEqual({ type: 'system', id: 'spend-guard' });
  });

  it('tells the owner once per pause; only the owner resumes', async () => {
    const sent: string[] = [];
    const notifier = createDecisionCardNotifier({
      database: db,
      logger,
      deliver: (text) => {
        sent.push(text);
        return Promise.resolve();
      },
    });
    await expect(notifier.runOnce()).resolves.toBe(1);
    await expect(notifier.runOnce()).resolves.toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^⛔ Автопауза: автоматика потратила сегодня \$6\.50/);
    const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    if (control === undefined) throw new Error('no kill switch');
    expect(() => resumeSystem(control, { actor: SYSTEM, at: now() })).toThrow(/Only the owner/);
    await db.repositories.systemControls.update(
      resumeSystem(control, { actor: OWNER, at: now() }),
      OWNER,
    );
    expect(JSON.stringify(records)).not.toContain('Logo design');
  });
});
