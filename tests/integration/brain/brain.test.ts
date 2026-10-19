import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerQuestion, searchBrain, similarCases } from '@roi-dealer/brain';
import { createCommandCenter, NOTE_PREFIX } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  costEntryIdSchema,
  createDecision,
  createEvidence,
  createKnowledgeAsset,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  knowledgeAssetIdSchema,
  opportunityIdSchema,
  painIdSchema,
  recordCostEntry,
  signalIdSchema,
  sourceIdSchema,
  toTimestamp,
  usd,
  type Actor,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import type { CallbackContext, CommandContext, InlineKeyboard } from '@roi-dealer/telegram';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
const { logger, records } = createCapturingLogger('bot');
const now = () => toTimestamp(new Date());
const OWNER_TG = 4242;
const ids = { opportunity: '', pain: '', knowledge: '' };

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  const source = createSource(sourceData(), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(source);
  const evidence = createEvidence(
    {
      sourceId: source.id,
      kind: 'post',
      excerpt: 'We pay a bookkeeper to reconcile Stripe payouts with QuickBooks every week.',
      observedAt: now(),
    },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  const signal = createSignal(
    {
      title: 'Agencies reconcile payouts by hand',
      summary: 'Reconciliation',
      evidenceIds: [evidence.id],
      markets: ['US'],
      strength: 'moderate',
    },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.signals.insert(signal);
  const pain = createPain(
    {
      title: 'Small agencies reconcile Stripe payouts by hand',
      description: 'Bookkeepers reconcile payouts with the accounting by hand every week',
      audience: 'Small agencies',
      desiredOutcome: 'Books that match payouts',
      severity: 3,
      frequency: 'rare',
      markets: ['US'],
      signalIds: [signal.id],
      evidenceIds: [evidence.id],
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  const opportunity = createOpportunity(
    {
      title: 'Automatic payout reconciliation for agencies',
      summary: 'Agencies lose hours reconciling payouts every week.',
      painIds: [pain.id],
      icp: 'Agencies with 2–20 people',
      markets: ['US'],
      valueProposition: {
        problem: 'Payouts do not match the books',
        change: 'Matched automatically',
        measurableResult: 'Six hours a week saved',
      },
      businessModel: { model: 'subscription' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.opportunities.insert(opportunity);
  await db.repositories.decisions.insert(
    createDecision(
      {
        subject: { type: 'opportunity', id: opportunity.id },
        outcome: 'more_research',
        rationale: 'Check how many agencies already pay to reconcile payouts.',
        evidenceIds: [],
      },
      { id: decisionIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
    ),
  );
  const knowledge = (title: string, tags: string[], actor: Actor = SYSTEM) =>
    createKnowledgeAsset(
      {
        kind: 'knowledge',
        title,
        summary: `${title}: agencies that reconcile payouts already have many tools`,
        links: { evidenceIds: [] },
        tags,
      },
      { id: knowledgeAssetIdSchema.parse(uuidv7()), actor, at: now() },
    );
  const lesson = knowledge('Reconciliation tools are crowded', ['lesson']);
  await db.repositories.knowledgeAssets.insert(lesson);
  await db.repositories.knowledgeAssets.insert(knowledge('Eval reconciliation report', ['eval']));
  const spent = recordCostEntry(
    {
      category: 'infrastructure',
      amount: usd(1_000),
      description: 'Railway',
      incurredAt: now(),
      recurring: false,
      allocation: {},
    },
    { id: costEntryIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.costEntries.insert(spent);
  await db.repositories.costEntries.insert(
    recordCostEntry(
      {
        category: 'infrastructure',
        amount: usd(250),
        description: 'Refund of a duplicate charge',
        incurredAt: now(),
        recurring: false,
        allocation: {},
        reversalOf: spent.id,
      },
      { id: costEntryIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
    ),
  );
  Object.assign(ids, { opportunity: opportunity.id, pain: pain.id, knowledge: lesson.id });
});

afterAll(async () => {
  await test.drop();
});

describe('full-text search over the Company Brain (migration 0009)', () => {
  it('finds every kind of record and leaves eval reports out', async () => {
    const { hits, similar } = await searchBrain(db, 'reconcile');
    expect(similar).toBe(false);
    expect(new Set(hits.map((hit) => hit.type))).toEqual(
      new Set(['pain', 'opportunity', 'evidence', 'knowledge', 'decision']),
    );
    expect(hits.some((hit) => hit.title.startsWith('Eval'))).toBe(false);
    const pain = hits.find((hit) => hit.type === 'pain');
    expect(pain).toMatchObject({
      id: ids.pain,
      title: 'Small agencies reconcile Stripe payouts by hand',
    });
    expect(pain?.snippet).toContain('«');
  });

  it('falls back to similar records, and hints when the words are not English', async () => {
    const result = await searchBrain(db, 'reconcile unicorns');
    expect(result).toMatchObject({ similar: true });
    expect(result.hits.length).toBeGreaterThan(0);
    // Similar records also match longer forms of a word: "quick" finds "QuickBooks".
    const forms = await searchBrain(db, 'quick');
    expect(forms.similar).toBe(true);
    expect(forms.hits.map((hit) => hit.type)).toContain('evidence');
    await expect(searchBrain(db, 'сверка платежей')).resolves.toEqual({
      hits: [],
      similar: false,
      needsEnglish: true,
    });
  });

  it('treats any characters as plain words', async () => {
    for (const input of [
      "'; drop table pains; --",
      '& | ! :* ( ) <-> \\',
      'reconcile" OR "1"="1',
    ]) {
      await expect(searchBrain(db, input)).resolves.toMatchObject({ needsEnglish: false });
    }
    expect(await db.repositories.pains.getById(ids.pain as never)).toBeDefined();
  });

  it('retrieves similar past cases without the given records', async () => {
    const cases = await similarCases(db, 'payout reconciliation tools', {
      excludeIds: [ids.opportunity],
    });
    expect(cases.map((hit) => hit.type)).not.toContain('pain');
    expect(cases.map((hit) => hit.id)).not.toContain(ids.opportunity);
    expect(cases.map((hit) => hit.id)).toContain(ids.knowledge);
  });
});

describe('questions answered from the database (§7.3)', () => {
  it('money with reversals subtracted, counts by status and news', async () => {
    await expect(answerQuestion(db, 'сколько потратили за неделю?', Date.now())).resolves.toEqual({
      kind: 'spend',
      period: 'week',
      totalCents: 750,
      byCategory: { infrastructure: 750 },
      entries: 2,
    });
    await expect(answerQuestion(db, 'сколько болей?', Date.now())).resolves.toEqual({
      kind: 'count',
      entity: 'pain',
      period: 'all',
      created: 1,
      byStatus: { candidate: 1 },
    });
    await expect(answerQuestion(db, 'сколько знаний?', Date.now())).resolves.toMatchObject({
      created: 1,
    });
    const news = await answerQuestion(db, 'что нового?', Date.now());
    expect(news).toMatchObject({
      kind: 'news',
      created: { evidence: 1, signal: 1, pain: 1, opportunity: 1, knowledge: 1, decision: 1 },
    });
    await expect(answerQuestion(db, 'сколько ушло на AI за месяц?', Date.now())).resolves.toEqual({
      kind: 'ai_spend',
      period: 'month',
      costMicroUsd: 0,
      calls: 0,
      failed: 0,
    });
  });
});

describe('/search, /ask and /note in the command center', () => {
  const center = () =>
    createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  let update = 1;

  async function command(name: string, args: string) {
    const replies: { text: string; keyboard?: InlineKeyboard | undefined }[] = [];
    const handler = center().commands.find((item) => item.name === name)?.handler;
    if (handler === undefined) throw new Error(`no ${name}`);
    const context: CommandContext = {
      chatId: OWNER_TG,
      userId: OWNER_TG,
      updateId: (update += 1),
      args,
      logger,
      reply: (text, keyboard) => {
        replies.push({ text, keyboard });
        return Promise.resolve();
      },
    };
    await handler(context);
    return replies;
  }

  async function press(cc: ReturnType<typeof center>, data: string, queryId: string) {
    const edits: string[] = [];
    const handler = cc.callbacks.find((item) => item.prefix === NOTE_PREFIX)?.handler;
    if (handler === undefined) throw new Error('no note button');
    const context: CallbackContext = {
      chatId: OWNER_TG,
      userId: OWNER_TG,
      updateId: (update += 1),
      callbackQueryId: queryId,
      messageId: 1,
      data: data.slice(NOTE_PREFIX.length + 1),
      logger,
      answer: () => Promise.resolve(),
      reply: () => Promise.resolve(),
      edit: (text) => {
        edits.push(text);
        return Promise.resolve();
      },
    };
    await handler(context);
    return edits;
  }

  it('answers /search and /ask with sources and records the views', async () => {
    const [found] = await command('search', 'reconcile');
    expect(found?.text).toMatch(/^🔎 «reconcile» · найдено: 5/);
    const [money] = await command('ask', 'сколько потратили за неделю?');
    expect(money?.text).toContain('💸 Расходы за последние 7 дней: $7.50 · записей 2');
    expect(money?.text).toContain('Источник: журнал расходов');
    const [usage] = await command('ask', '');
    expect(usage?.text).toContain('Спросите систему');
    const views = await db.access.list({ decision: 'allowed', limit: 10 });
    expect(views.map((view) => view.permission)).toContain('research.read');
  });

  it('/note stores only after confirmation, once per press, never after expiry', async () => {
    const cc = center();
    const handler = cc.commands.find((item) => item.name === 'note')?.handler;
    if (handler === undefined) throw new Error('no note');
    const replies: { text: string; keyboard?: InlineKeyboard | undefined }[] = [];
    await handler({
      chatId: OWNER_TG,
      userId: OWNER_TG,
      updateId: (update += 1),
      args: 'Agencies prefer weekly reports\nThree of five said so on calls.',
      logger,
      reply: (text, keyboard) => {
        replies.push({ text, keyboard });
        return Promise.resolve();
      },
    });
    expect(replies[0]?.text).toContain('«Agencies prefer weekly reports»');
    const [yes, no] = replies[0]?.keyboard?.[0] ?? [];
    const before = await db.repositories.knowledgeAssets.listByTags(['owner-note']);
    expect(before).toEqual([]);

    expect(await press(cc, yes?.callback_data ?? '', 'q-1')).toEqual([
      '📝 Записано в базу знаний: «Agencies prefer weekly reports».\nНайти: /search',
    ]);
    // The same press delivered twice stores nothing more.
    await press(cc, yes?.callback_data ?? '', 'q-1');
    const notes = await db.repositories.knowledgeAssets.listByTags(['owner-note']);
    expect(notes).toMatchObject([
      { title: 'Agencies prefer weekly reports', kind: 'knowledge', createdBy: { type: 'owner' } },
    ]);
    expect((await searchBrain(db, 'weekly reports')).hits[0]?.id).toBe(notes[0]?.id);

    // Cancelled and unknown confirmations store nothing.
    expect(await press(cc, no?.callback_data ?? '', 'q-2')).toEqual([
      'Отменено. Ничего не записано.',
    ]);
    expect(await press(cc, `${NOTE_PREFIX}:y:feedfeedfeedfeed`, 'q-3')).toEqual([
      '⌛ Подтверждение устарело. Повторите /note.',
    ]);
    expect(await db.repositories.knowledgeAssets.listByTags(['owner-note'])).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('Three of five');
  });
});
