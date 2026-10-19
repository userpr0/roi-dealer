import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDigest,
  createCommandCenter,
  createDecisionCardNotifier,
  OPPORTUNITY_PREFIX,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  addSignalToPain,
  AUTOMATION_CONTROL_ID,
  createEvidence,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  JUDGE_CRITERIA,
  opportunityIdSchema,
  painIdSchema,
  pauseSystem,
  resumeSystem,
  signalIdSchema,
  sourceIdSchema,
  submitOpportunityForReview,
  toTimestamp,
  type JudgeCriterion,
  type Opportunity,
  type Pain,
  type Source,
  type SystemControl,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let forum: Source;
const { logger } = createCapturingLogger('bot');
const now = () => toTimestamp(new Date());
const OWNER_TG = 4242;
let update = 100;

/** A judged opportunity under review, the way PHASE 07–11 leave it. */
async function underReview(
  title: string,
  scores: Record<JudgeCriterion, number>,
): Promise<{ opportunity: Opportunity; pain: Pain }> {
  const evidence = createEvidence(
    {
      sourceId: forum.id,
      kind: 'post',
      excerpt: `${title}: we pay $300 a month for this.`,
      url: 'https://news.ycombinator.com/item?id=10',
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
      icp: 'Freelancers and two-person studios',
      markets: ['US'],
      valueProposition: {
        problem: 'Clients pay invoices late',
        change: 'Reminders run on their own',
        measurableResult: 'A day a month back',
      },
      businessModel: { model: 'subscription', pricingHypothesis: '$12 a month' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.opportunities.insert(draft);
  for (const criterion of JUDGE_CRITERIA) {
    await db.judgements.record({
      opportunityId: draft.id,
      opportunityVersion: draft.version,
      criterion,
      taskVersion: 1,
      outcome: 'judged',
      score: scores[criterion],
      supported: true,
      rationale: `Judged ${criterion} from the posts.`,
      concerns: [`Check ${criterion}.`],
      evidenceIds: [evidence.id],
      actorType: 'agent',
      actorId: 'judges',
    });
  }
  const opportunity = submitOpportunityForReview(draft, { actor: SYSTEM, at: now() });
  await db.repositories.opportunities.update(opportunity, SYSTEM);
  return { opportunity, pain };
}

const scores = (score: number, overrides: Partial<Record<JudgeCriterion, number>> = {}) =>
  ({
    ...Object.fromEntries(JUDGE_CRITERIA.map((criterion) => [criterion, score])),
    ...overrides,
  }) as Record<JudgeCriterion, number>;

function center(cards?: { text: string; keyboard?: InlineKeyboard | undefined }[]): CommandCenter {
  return createCommandCenter({
    database: db,
    logger,
    deliverDigest: () => Promise.resolve(),
    deliverCard:
      cards === undefined
        ? undefined
        : (text, keyboard) => {
            cards.push({ text, keyboard });
            return Promise.resolve();
          },
  });
}

async function decisions(cc: CommandCenter) {
  const replies: { text: string; keyboard?: InlineKeyboard | undefined }[] = [];
  const handler = cc.commands.find((item) => item.name === 'decisions')?.handler;
  if (handler === undefined) throw new Error('no /decisions');
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

async function press(cc: CommandCenter, data: string, queryId = `q-${String((update += 1))}`) {
  const edits: { text: string; keyboard?: InlineKeyboard | undefined }[] = [];
  const answers: string[] = [];
  const handler = cc.callbacks.find((item) => item.prefix === OPPORTUNITY_PREFIX)?.handler;
  if (handler === undefined) throw new Error('no opportunity buttons');
  const context: CallbackContext = {
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    callbackQueryId: queryId,
    messageId: 1,
    data: data.slice(OPPORTUNITY_PREFIX.length + 1),
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
  return { edits, answers };
}

const recordedDecisions = async () => {
  const rows = await db.sql<{ id: string }[]>`select id from decisions order by created_at, id`;
  return db.repositories.decisions.getByIds(rows.map((row) => row.id as never));
};

const buttonData = (keyboard: InlineKeyboard | undefined) =>
  (keyboard ?? []).flat().map((item) => item.callback_data);

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = (await db.repositories.systemControls.getById(
    AUTOMATION_CONTROL_ID,
  )) as SystemControl;
  const next = paused
    ? pauseSystem(control, 'Тест стоп-крана', { actor: OWNER, at: now() })
    : resumeSystem(control, { actor: OWNER, at: now() });
  await db.repositories.systemControls.update(next, OWNER);
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  forum = createSource(sourceData({ name: 'Test forum' }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(forum);
});

afterAll(async () => {
  await test.drop();
});

describe('the decision card (PHASE 12)', () => {
  let strong: Opportunity;

  it('/decisions shows the opportunities under review with three buttons', async () => {
    ({ opportunity: strong } = await underReview('Invoices that get paid', scores(4)));
    const replies = await decisions(center());
    expect(replies[0]?.text).toBe('⚖️ Возможностей на решение: 1');
    const card = replies[1];
    expect(card?.text).toContain('💡 Возможность на решение\n«Invoices that get paid»');
    expect(card?.text).toContain('⚖️ Судьи: 75/100');
    expect(card?.text).toContain('Рекомендация системы: ✅ проверять — сильная по всем пунктам.');
    expect(card?.text).toContain('https://news.ycombinator.com/item?id=10');
    expect(buttonData(card?.keyboard)).toEqual([
      `op:a:${strong.id}:${String(strong.version)}`,
      `op:r:${strong.id}:${String(strong.version)}`,
      `op:m:${strong.id}:${String(strong.version)}`,
    ]);
  });

  it('asks for confirmation, then records the owner’s decision once', async () => {
    const cc = center();
    const v = String(strong.version);
    const asked = await press(cc, `op:a:${strong.id}:${v}`);
    expect(asked.edits[0]?.text).toContain('❓ Проверять «Invoices that get paid»?');
    expect(buttonData(asked.edits[0]?.keyboard)).toEqual([
      `op:ya:${strong.id}:${v}`,
      `op:c:${strong.id}:${v}`,
    ]);
    // Back to the card changes nothing.
    const back = await press(cc, `op:c:${strong.id}:${v}`);
    expect(buttonData(back.edits[0]?.keyboard)).toHaveLength(3);
    expect(await recordedDecisions()).toEqual([]);

    const confirmed = await press(cc, `op:ya:${strong.id}:${v}`, 'q-approve');
    expect(confirmed.edits[0]?.text).toContain('✅ Решение: проверять.');
    expect(confirmed.answers).toEqual(['Решение записано']);
    // The same press delivered again decides nothing more.
    await press(cc, `op:ya:${strong.id}:${v}`, 'q-approve');
    const recorded = await recordedDecisions();
    expect(recorded).toMatchObject([
      {
        subject: { type: 'opportunity', id: strong.id },
        outcome: 'approve',
        createdBy: { type: 'owner', id: `telegram:${String(OWNER_TG)}` },
      },
    ]);
    expect(recorded[0]?.rationale).toContain('Owner decision: approve.');
    expect(recorded[0]?.rationale).toContain('System recommendation: approve (strong).');
    expect(recorded[0]?.evidenceIds).toHaveLength(1);
    const approved = await db.repositories.opportunities.getById(strong.id);
    expect(approved).toMatchObject({ status: 'approved', lastDecisionId: recorded[0]?.id });

    // A stale card cannot decide again.
    const stale = await press(cc, `op:yr:${strong.id}:${v}`);
    expect(stale.edits[0]?.text).toContain('✅ Уже решено: проверять.');
    expect(await recordedDecisions()).toHaveLength(1);
    const audit = await db.access.list({ decision: 'allowed', limit: 50 });
    expect(audit.map((entry) => entry.permission)).toContain('decision.record');
  });

  it('rejects, and sends back for research until new signals arrive', async () => {
    const { opportunity: risky } = await underReview(
      'Bots that buy tickets',
      scores(4, { risk: 1 }),
    );
    const { opportunity: unsure, pain } = await underReview(
      'Reminders for plant watering',
      scores(3),
    );
    const cc = center();
    const [, riskyCard] = await decisions(cc);
    expect(riskyCard?.text).toContain('❌ не брать — критический недостаток: риск');
    await press(cc, `op:yr:${risky.id}:${String(risky.version)}`);
    expect((await db.repositories.opportunities.getById(risky.id))?.status).toBe('rejected');

    await press(cc, `op:ym:${unsure.id}:${String(unsure.version)}`);
    const back = await db.repositories.opportunities.getById(unsure.id);
    expect(back).toMatchObject({ status: 'draft', version: unsure.version + 1 });
    // The judges do not judge the same material again...
    const pending = () => db.judgements.pending({ marketAgent: 'market-analyst', waitMs: 0 });
    expect((await pending()).map((item) => item.id)).not.toContain(unsure.id);
    // ...until a pain of the opportunity has a new signal.
    const evidence = createEvidence(
      { sourceId: forum.id, kind: 'post', excerpt: 'Another plant post.', observedAt: now() },
      { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
    );
    await db.repositories.evidence.insert(evidence);
    const signal = createSignal(
      {
        title: 'More',
        summary: 'More',
        evidenceIds: [evidence.id],
        markets: ['US'],
        strength: 'weak',
      },
      { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
    );
    await db.repositories.signals.insert(signal);
    await db.repositories.pains.update(
      addSignalToPain(pain, signal, { actor: SYSTEM, at: now() }),
      SYSTEM,
    );
    expect((await pending()).map((item) => item.id)).toContain(unsure.id);
  });
});

describe('cards arrive by themselves (PHASE 12)', () => {
  it('each version once, retried after a failed delivery, stopped by the kill switch', async () => {
    const { opportunity } = await underReview(
      'Fewer no-shows for clinics',
      scores(4, { reuse: 2 }),
    );
    const delivered: string[] = [];
    let fail = true;
    const notifier = createDecisionCardNotifier({
      database: db,
      logger,
      deliver: (text) => {
        if (fail) return Promise.reject(new Error('telegram is down'));
        delivered.push(text);
        return Promise.resolve();
      },
    });
    await setKillSwitch(true);
    await expect(notifier.runOnce()).resolves.toBe(0);
    await setKillSwitch(false);
    await expect(notifier.runOnce()).rejects.toThrow('telegram is down');
    fail = false;
    await expect(notifier.runOnce()).resolves.toBe(1);
    expect(delivered[0]).toContain('«Fewer no-shows for clinics»');
    await expect(notifier.runOnce()).resolves.toBe(0);

    const digest = await buildDigest(db, Date.now());
    expect(digest).toContain('⚖️ Возможностей на решение: 1 → /decisions');
    // Through the command center the bot starts and stops it.
    const cards: { text: string; keyboard?: InlineKeyboard | undefined }[] = [];
    const cc = center(cards);
    cc.startCards();
    await cc.stopCards();
    expect(opportunity.status).toBe('under_review');
  });
});
