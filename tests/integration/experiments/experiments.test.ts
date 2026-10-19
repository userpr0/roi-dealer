import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toHypothesisSet } from '@roi-dealer/agents';
import { createCommandCenter, type CommandCenter } from '@roi-dealer/command-center';
import { ConstraintViolationError, type Database } from '@roi-dealer/database';
import {
  applyOpportunityDecision,
  createDecision,
  createEvidence,
  createHypothesis,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  hypothesisIdSchema,
  opportunityIdSchema,
  painIdSchema,
  signalIdSchema,
  sourceIdSchema,
  STOP_REASONS,
  submitOpportunityForReview,
  toTimestamp,
  usd,
  type Experiment,
  type ExperimentId,
  type Hypothesis,
  type Opportunity,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { perfectHypothesesAnswer } from '../../support/agent-answers.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let opportunity: Opportunity;
let hypotheses: Hypothesis[];
const { logger, records } = createCapturingLogger('bot');
const now = () => toTimestamp(new Date());
const OWNER_TG = 5151;
const OWNER_ACTOR = { type: 'owner', id: `telegram:${String(OWNER_TG)}` };
let update = 500;

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

async function press(data: string, queryId = `q-${String((update += 1))}`) {
  const edits: Message[] = [];
  const answers: string[] = [];
  const [prefix = ''] = data.split(':');
  const handler = cc.callbacks.find((item) => item.prefix === prefix)?.handler;
  if (handler === undefined) throw new Error(`no ${prefix} buttons`);
  const context: CallbackContext = {
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    callbackQueryId: queryId,
    messageId: 1,
    data: data.slice(prefix.length + 1),
    logger,
    answer: (text) => {
      answers.push(text ?? '');
      return Promise.resolve();
    },
    reply: () => Promise.resolve(),
    edit: (text, keyboard) => {
      edits.push({ text, keyboard });
      return Promise.resolve();
    },
  };
  await handler(context);
  return { edits, answers, text: edits.at(-1)?.text ?? '' };
}

const buttons = (message: Message | undefined) =>
  (message?.keyboard ?? []).flat().map((item) => item.callback_data);

const experimentOf = async (hypothesis: Hypothesis): Promise<Experiment> => {
  const [row] = await db.sql<{ id: string }[]>`
    select id from experiments where hypothesis_id = ${hypothesis.id}
    order by created_at desc limit 1
  `;
  const experiment = await db.repositories.experiments.getById(row?.id as ExperimentId);
  if (experiment === undefined) throw new Error('no experiment');
  return experiment;
};
const button = (experiment: Experiment, action: string) =>
  `ex:${action}:${experiment.id}:${String(experiment.version)}`;
const hypothesisButton = (hypothesis: Hypothesis, action: string) =>
  `hy:${action}:${hypothesis.id}:${String(hypothesis.version)}`;

/** An opportunity the owner approved (PHASE 12) with five hypotheses (PHASE 14). */
async function approvedWithHypotheses(title: string): Promise<[Opportunity, Hypothesis[]]> {
  const forum = createSource(sourceData({ name: `Forum ${title}` }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(forum);
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
  const approved = applyOpportunityDecision(review, decision);
  await db.repositories.opportunities.update(approved, OWNER);
  const checked = toHypothesisSet(
    approved.id,
    ['US'],
    perfectHypothesesAnswer({ markets: ['US'], audience: 'Freelancers' }),
  );
  if (!('hypotheses' in checked)) throw new Error(checked.issues.join('; '));
  const stored = checked.hypotheses.map((data) =>
    createHypothesis(data, { id: hypothesisIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() }),
  );
  await db.transaction(async ({ repositories }) => {
    for (const item of stored) await repositories.hypotheses.insert(item);
  });
  // The order /hypotheses shows (hypotheses created in the same millisecond sort by id).
  return [approved, await db.repositories.hypotheses.listByOpportunities([approved.id])];
}

/** The hypothesis that tests by `method`. */
const by = (method: Hypothesis['validationMethod']): Hypothesis =>
  hypotheses.find((item) => item.validationMethod === method) ?? expect.unreachable();

const fresh = async (hypothesis: Hypothesis) =>
  (await db.repositories.hypotheses.getById(hypothesis.id)) ?? expect.unreachable();

/** Selects the hypothesis, confirms the checklist, approves the launch and starts the test. */
async function launched(hypothesis: Hypothesis): Promise<Experiment> {
  await press(hypothesisButton(await fresh(hypothesis), 'yt'));
  await press(button(await experimentOf(hypothesis), 'yp'));
  const experiment = await experimentOf(hypothesis);
  await press(`ap:ya:${String(experiment.approvalRequestId)}`);
  await press(button(await experimentOf(hypothesis), 'yg'));
  return experimentOf(hypothesis);
}

/** Reports through /funnel and confirms. */
async function report(args: string): Promise<{ question: string; result: string }> {
  const [question] = await run('funnel', args);
  const yes = buttons(question).find((data) => data.startsWith('fn:y:'));
  if (yes === undefined) return { question: question?.text ?? '', result: '' };
  const { text } = await press(yes);
  return { question: question?.text ?? '', result: text };
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  cc = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  [opportunity, hypotheses] = await approvedWithHypotheses('Invoices that get paid');
});

afterAll(async () => {
  await test.drop();
});

describe('choosing a hypothesis to test (PHASE 15)', () => {
  it('plans the test from /hypotheses with a confirmation', async () => {
    const [header, card] = await run('hypotheses');
    expect(header?.text).toContain('🧪 N — проверить гипотезу N');
    expect(card?.text).toContain('успех: заявки ≥ 20');
    expect(buttons(card)).toEqual(hypotheses.map((item) => hypothesisButton(item, 't')));

    const landing = by('landing_page');
    const asked = await press(hypothesisButton(landing, 't'));
    expect(asked.text).toContain(
      `❓ Проверить гипотезу ${String(hypotheses.indexOf(landing) + 1)}? План: лендинг · срок 14 дней · бюджет $50.00, stop-loss ` +
        '$20.00 · успех: заявки ≥ 20.',
    );
    expect(await db.repositories.experiments.listByStatus('planned')).toEqual([]);

    const chosen = await press(hypothesisButton(landing, 'yt'), 'q-select');
    expect(chosen.text).toContain('🧪 Тест запланирован');
    expect(chosen.answers).toEqual(['Тест запланирован']);
    // The same press delivered again plans nothing more.
    await press(hypothesisButton(landing, 'yt'), 'q-select');
    const planned = await db.repositories.experiments.listByStatus('planned');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      hypothesisId: landing.id,
      opportunityId: opportunity.id,
      artifact: 'landing',
      testBudget: usd(5_000),
      stopLoss: usd(2_000),
      successMetric: { name: 'lead', target: 20, unit: 'count', direction: 'at_least' },
      honestChecks: [],
      createdBy: OWNER_ACTOR,
    });
    expect((await fresh(landing)).status).toBe('selected');
    // The chosen hypothesis has no 🧪 button any more; a stale card cannot choose it again.
    expect(buttons(chosen.edits.at(-1))).toHaveLength(4);
    const stale = await press(hypothesisButton(landing, 'yt'));
    expect(stale.text).toContain('Карточка устарела');
  });
});

describe('the honest-test checklist and the launch (D-014 п.8, D-006)', () => {
  it('asks for the checklist, then requests the launch in /decisions', async () => {
    const landing = by('landing_page');
    const [header, card] = await run('experiments');
    expect(header?.text).toContain('🧪 Тесты: 1');
    expect(card?.text).toContain('🧪 №1 · «Invoices that get paid» — лендинг · US');
    expect(card?.text).toContain('Статус: 📝 план');
    expect(card?.text).toContain('Успех: заявки ≥ 20 · сейчас 0');
    expect(card?.text).toContain('Воронка: данных пока нет');
    expect(card?.text).toContain('Потрачено $0.00 из $50.00 · stop-loss $20.00');
    const experiment = await experimentOf(landing);
    expect(buttons(card)).toEqual([button(experiment, 'p'), button(experiment, 'x')]);

    const [notYet] = await run('funnel', '1 клики 5');
    expect(notYet?.text).toBe('Тест №1 ещё не запущен: 📝 план.');

    const asked = await press(button(experiment, 'p'));
    expect(asked.text).toContain('☑️ Чек-лист честной проверки');
    expect(asked.text).toContain('4. Если продукта ещё нет — прямо сказано «скоро»');
    expect(asked.text).toContain('5. На странице: политика конфиденциальности');
    expect(asked.text).toContain('Дальше — запрос на запуск в /decisions на $50.00.');

    const requested = await press(button(experiment, 'yp'));
    expect(requested.text).toContain('🚀 Запуск на $50.00 запрошен');
    const awaiting = await experimentOf(landing);
    expect(awaiting).toMatchObject({
      status: 'awaiting_approval',
      honestChecks: [
        'no_fabrication',
        'channel_rules',
        'funnel_tracking',
        'fake_door_disclosed',
        'page_legal',
      ],
    });
    const request = await db.repositories.approvalRequests.getById(
      awaiting.approvalRequestId ?? expect.unreachable(),
    );
    expect(request).toMatchObject({
      kind: 'experiment_launch',
      status: 'pending',
      amount: usd(5_000),
      subject: { type: 'experiment', id: awaiting.id },
      title: 'Тест: «Invoices that get paid» — лендинг',
    });

    const [decisionCard] = (await run('decisions')).slice(1);
    expect(decisionCard?.text).toContain('📥 Запуск эксперимента · $50.00');
    const approved = await press(`ap:ya:${String(request?.id)}`);
    expect(approved.text).toContain('🧪 Запуск одобрен');
    expect((await experimentOf(landing)).status).toBe('approved');

    const started = await press(button(await experimentOf(landing), 'yg'));
    expect(started.text).toContain('▶️ Тест идёт');
    const running = await experimentOf(landing);
    expect(running.status).toBe('running');
    expect((await fresh(landing)).status).toBe('testing');
    expect((await db.repositories.opportunities.getById(opportunity.id))?.status).toBe(
      'validating',
    );
    expect(buttons(started.edits.at(-1))).toEqual([button(running, 's'), button(running, 'o')]);
  });
});

describe('the funnel, spend and the stop-loss (D-014 п.9, §2.19)', () => {
  it('records the owner’s numbers and spend within the approved budget', async () => {
    const landing = by('landing_page');
    const experiment = await experimentOf(landing);
    const first = await report('1 показы 1000 клики 30 заявки 4 $12.50');
    expect(first.question).toContain('показы: 0 → 1000 (+1000)');
    expect(first.question).toContain('заявки: 0 → 4 (+4)');
    expect(first.question).toContain('Потрачено: $0.00 → $12.50 из $50.00 · stop-loss $20.00');
    expect(first.question).toContain('Успех: заявки ≥ 20 · станет 4');
    expect(first.result).toContain('📊 Записано.');
    expect((await db.funnel.totals([experiment.id])).get(experiment.id)).toEqual({
      impression: 1_000,
      cta_click: 30,
      lead: 4,
    });
    expect((await db.funnel.spent([experiment.id])).get(experiment.id)).toEqual(usd(1_250));
    const [cost] = await db.sql<{ category: string; approval_request_id: string }[]>`
      select category, approval_request_id from cost_entries where experiment_id = ${experiment.id}
    `;
    expect(cost).toEqual({ category: 'ads', approval_request_id: experiment.approvalRequestId });
    const events = await db.sql<{ source: string; actor_id: string; channel: string }[]>`
      select source, actor_id, channel from experiment_events where experiment_id = ${experiment.id}
    `;
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      source: 'owner_report',
      actor_id: OWNER_ACTOR.id,
      channel: 'Reddit ads',
    });

    const [tooMuch] = await run('funnel', '1 $40');
    expect(tooMuch?.text).toContain('⛔ Траты превысят одобренный бюджет $50.00');
    expect((await db.funnel.spent([experiment.id])).get(experiment.id)).toEqual(usd(1_250));
  });

  it('stops the test at the stop-loss when the metric is not reached', async () => {
    const landing = by('landing_page');
    const second = await report('1 заявки 1 $8');
    expect(second.question).toContain('⚠️ Тест остановится: сработал stop-loss.');
    expect(second.result).toContain('⏹ Тест остановлен: сработал stop-loss.');
    const stopped = await experimentOf(landing);
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: STOP_REASONS.stopLoss });
    const [card] = (await run('experiments')).slice(1);
    expect(card?.text).toContain('Остановлен: сработал stop-loss');
    expect(card?.text).toContain('Воронка: показы 1000 → клики CTA 30 → заявки 5');
    expect(buttons(card)).toEqual([button(stopped, 'o')]);
  });
});

describe('the result (§7.1 H, §2.9)', () => {
  it('needs the other tests of the opportunity done before closing it', async () => {
    const landing = by('landing_page');
    const demo = by('demo');
    await press(hypothesisButton(await fresh(demo), 'yt'));
    const stopped = await experimentOf(landing);
    const preview = await press(button(stopped, 'o'));
    expect(preview.text).toContain(
      '🏁 Итог: заявки ≥ 20 — сейчас 5, не достигнута. Гипотеза будет опровергнута.',
    );
    const refused = await press(button(stopped, 'rk'));
    expect(refused.text).toContain('⛔ Сначала завершите или отмените другие тесты');
    expect((await experimentOf(landing)).status).toBe('stopped');

    // Cancelling the other test discards its hypothesis.
    const other = await experimentOf(demo);
    const cancelled = await press(button(other, 'yx'));
    expect(cancelled.text).toContain('✖️ Тест отменён, гипотеза отброшена.');
    expect((await experimentOf(demo)).status).toBe('cancelled');
    expect((await fresh(demo)).status).toBe('discarded');
  });

  it('records a pivot: knowledge, the owner’s decision and the refuted hypothesis', async () => {
    const landing = by('landing_page');
    const result = await press(button(await experimentOf(landing), 'rp'), 'q-pivot');
    expect(result.text).toContain('↪️ Сменить подход: итог записан. Гипотеза опровергнута.');
    await press(button(await experimentOf(landing), 'rp'), 'q-pivot');
    const completed = await experimentOf(landing);
    expect(completed.status).toBe('completed');
    expect(completed.result?.outcome).toBe('pivot');
    expect((await fresh(landing)).status).toBe('refuted');
    const [asset] = await db.repositories.knowledgeAssets.getByIds(
      completed.result?.assetIds ?? [],
    );
    expect(asset).toMatchObject({
      kind: 'failure_pattern',
      tags: ['experiment-result', 'landing_page'],
      links: { experimentId: completed.id, hypothesisId: landing.id },
    });
    expect(asset?.summary).toContain('Funnel: impression 1000 → cta_click 30 → lead 5.');
    expect(asset?.summary).toContain('Success metric lead at least 20: 5 — not reached.');
    expect(asset?.summary).toContain(
      'Spent $20.50 of $50.00 (stop-loss $20.00). Stop-loss reached.',
    );
    const decisions = await db.sql<{ outcome: string; created_by_id: string }[]>`
      select outcome, created_by_id from decisions where subject_id = ${completed.id}
    `;
    expect(decisions).toEqual([{ outcome: 'pivot', created_by_id: OWNER_ACTOR.id }]);
    // The opportunity stays under validation for the next hypothesis.
    expect((await db.repositories.opportunities.getById(opportunity.id))?.status).toBe(
      'validating',
    );
    const [found] = await run('search', 'test result');
    expect(found?.text).toContain('Test result — Invoices that get paid (landing_page)');
  });

  it('scales the opportunity when the metric is reached', async () => {
    const preorder = by('preorder');
    const experiment = await launched(preorder);
    expect(experiment.honestChecks).toEqual([
      'no_fabrication',
      'channel_rules',
      'funnel_tracking',
      'page_legal',
      'refund_terms',
      'payment_tested',
    ]);
    const [card] = (await run('experiments')).slice(1);
    const number = /№(\d+)/.exec(card?.text ?? '')?.[1];
    const { result } = await report(`${String(number)} заявки 25 оплаты 3 $15`);
    expect(result).toContain('📊 Записано.');
    // Past the stop-loss, but the metric is reached: the test goes on.
    expect((await experimentOf(preorder)).status).toBe('running');

    const done = await press(button(await experimentOf(preorder), 'rs'));
    expect(done.text).toContain('🚀 Масштабировать: итог записан. Гипотеза подтверждена.');
    expect((await fresh(preorder)).status).toBe('confirmed');
    expect((await db.repositories.opportunities.getById(opportunity.id))?.status).toBe('scaling');
    const decisions = await db.sql<{ subject_type: string; outcome: string }[]>`
      select subject_type, outcome from decisions
      where subject_id in (${(await experimentOf(preorder)).id}, ${opportunity.id})
        and outcome = 'scale'
      order by subject_type
    `;
    expect(decisions).toEqual([
      { subject_type: 'experiment', outcome: 'scale' },
      { subject_type: 'opportunity', outcome: 'scale' },
    ]);
  });

  it('returns a rejected launch to planning; a cancelled one cancels its request', async () => {
    const concierge = by('concierge');
    await press(hypothesisButton(await fresh(concierge), 'yt'));
    await press(button(await experimentOf(concierge), 'yp'));
    const first = await experimentOf(concierge);
    const rejected = await press(`ap:yr:${String(first.approvalRequestId)}`);
    expect(rejected.text).toContain('🧪 Тест вернулся к планированию');
    const planned = await experimentOf(concierge);
    expect(planned).toMatchObject({ status: 'planned', honestChecks: first.honestChecks });

    const again = await press(button(planned, 'p'));
    expect(again.text).toContain('❓ Запросить запуск теста на $50.00 в /decisions?');
    await press(button(planned, 'yp'));
    const awaiting = await experimentOf(concierge);
    expect(awaiting.approvalRequestId).not.toBe(first.approvalRequestId);
    await press(button(awaiting, 'yx'));
    const request = await db.repositories.approvalRequests.getById(
      awaiting.approvalRequestId ?? expect.unreachable(),
    );
    expect(request?.status).toBe('cancelled');
    expect((await experimentOf(concierge)).status).toBe('cancelled');
  });

  it('records every press with its permission and logs no texts', async () => {
    const audit = await db.access.list({ decision: 'allowed', limit: 200 });
    expect(audit.map((entry) => entry.permission)).toContain('experiment.write');
    expect(JSON.stringify(records)).not.toContain('we pay $300');
    expect(JSON.stringify(records)).not.toContain('Freelancers');
  });
});

describe('the database keeps the rules (migration 0012)', () => {
  it('refuses a running experiment without the checklist', async () => {
    const interviews = by('interviews');
    await press(hypothesisButton(await fresh(interviews), 'yt'));
    const planned = await experimentOf(interviews);
    const error = await db.sql`
      update experiments set status = 'running', started_at = now(), version = version + 1,
        approval_request_id = ${(await experimentOf(by('preorder'))).approvalRequestId ?? null}
      where id = ${planned.id}
    `.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ constraint_name: 'experiments_checks_before_start' });
  });

  it('keeps funnel events append-only and tied to the experiment’s hypothesis', async () => {
    const preorder = await experimentOf(by('preorder'));
    const update = await db.sql`update experiment_events set quantity = 1`.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(String(update)).toContain('UPDATE on experiment_events is not allowed');
    await expect(
      db.funnel.record(
        [
          {
            experimentId: preorder.id,
            hypothesisId: by('landing_page').id,
            stage: 'lead',
            quantity: 1,
            channel: 'Reddit ads',
            utm: { source: 'reddit' },
            occurredAt: now(),
            source: 'tracker',
          },
        ],
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ConstraintViolationError);
    await expect(
      db.funnel.record(
        [
          {
            experimentId: preorder.id,
            hypothesisId: preorder.hypothesisId,
            stage: 'lead',
            quantity: 1,
            channel: 'Reddit ads',
            utm: {},
            occurredAt: now(),
            source: 'tracker',
          },
        ],
        { type: 'integration', id: 'source:tracker' },
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });
});
