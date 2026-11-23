import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fileLibraryTask,
  LIBRARIAN,
  librarianAgent,
  runAgent,
  type FileLibraryExpected,
  type FileLibraryOutput,
} from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import {
  createCommandCenter,
  ensureAccessRequest,
  libraryDigestLine,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  createEvidence,
  createLibraryVertical,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  libraryVerticalIdSchema,
  opportunityIdSchema,
  painIdSchema,
  signalIdSchema,
  sourceIdSchema,
  toTimestamp,
  type Opportunity,
  type Pain,
  type Source,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';
import { ownerRouter } from '../../support/owner-router.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let runtime: AiRuntime;
let center: CommandCenter;
let source: Source;
const { logger } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());

const golden = new Map(
  fileLibraryTask.evalCases.map((c) => [fileLibraryTask.render(c.input), c.expected]),
);
const answer = (place: string, vertical = '', project = '', topic = ''): FileLibraryOutput => ({
  place,
  vertical,
  project,
  topic,
});
function perfect(expected: FileLibraryExpected): FileLibraryOutput {
  if (!('existing' in expected)) return answer(expected.place);
  return answer(
    'new',
    expected.vertical ?? 'Новая сфера',
    expected.project ?? 'Новый проект',
    'Тема',
  );
}
/** What the fake model answers for the pains of these tests. */
let nextAnswer: FileLibraryOutput = answer(
  'new',
  'Недвижимость',
  'Арендодатели',
  'Заявки на ремонт',
);

function oracle(request: FakeAiRequest) {
  if (request.instructions !== fileLibraryTask.instructions) return { status: 400 };
  const expected = golden.get(request.prompt);
  return { text: JSON.stringify(expected === undefined ? nextAnswer : perfect(expected)) };
}

const run = () =>
  runAgent(librarianAgent(), {
    database: db,
    logger,
    runtime,
    ensureAccess: ensureAccessRequest,
    now: Date.now,
    signal: new AbortController().signal,
  });

async function painOf(title: string): Promise<Pain> {
  const evidence = createEvidence(
    { sourceId: source.id, kind: 'post', excerpt: title, observedAt: now() },
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
      audience: 'Small landlords',
      desiredOutcome: 'Nothing gets lost',
      severity: 3,
      frequency: 'occasional',
      markets: ['US'],
      signalIds: [signal.id],
      evidenceIds: [evidence.id],
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  return pain;
}

async function opportunityOf(pain: Pain): Promise<Opportunity> {
  const opportunity = createOpportunity(
    {
      title: 'Repair request inbox for small landlords',
      summary: 'Landlords lose repair requests in texts and calls.',
      painIds: [pain.id],
      icp: 'Landlords with 1–20 units',
      markets: ['US'],
      valueProposition: {
        problem: 'Requests get lost',
        change: 'One inbox for every request',
        measurableResult: 'No lost request in a month',
      },
      businessModel: { model: 'subscription' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.opportunities.insert(opportunity);
  return opportunity;
}

const work = (painId: string) =>
  db.sql<{ outcome: string; subject_version: number }[]>`
    select outcome, subject_version from agent_work
    where agent = ${LIBRARIAN.id} and subject_id = ${painId} order by id
  `;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [
      createAnthropicProvider({ apiKey: 'sk-ant-library-test', baseUrl: claude.baseUrl }),
    ],
    timeoutMs: 5_000,
  });
  center = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  source = createSource(sourceData({ name: 'r/landlord' }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(source);
});

afterAll(async () => {
  await center.stopDigest();
  await claude.close();
  await test.drop();
});

beforeEach(() => {
  claude.answer(oracle);
});

describe('the librarian files pains and opportunities (phase 35)', () => {
  let first: Pain;
  let opportunity: Opportunity;

  it('asks the owner for access before it reads anything', async () => {
    first = await painOf('Landlords lose track of tenant repair requests');
    opportunity = await opportunityOf(first);
    await expect(run()).resolves.toBe('no_access');
    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Библиотекарь');
    expect(claude.calls).toEqual([]);
  });

  it('files a pain under a new place and puts its opportunity next to it', async () => {
    const principal = await db.repositories.principals.getByActor(LIBRARIAN);
    if (principal === undefined) throw new Error('no access request');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
    const [report] = await runtime.evaluateMissing([fileLibraryTask]);
    expect(report?.score.passed).toBe(true);

    await expect(run()).resolves.toBe('done');
    const topicId = await db.library.topicOf('pain', first.id);
    const tree = await db.library.tree();
    expect(tree.verticals.map((item) => item.name)).toEqual(['Недвижимость']);
    expect(tree.topics.map((item) => [item.name, item.createdBy])).toEqual([
      ['Заявки на ремонт', LIBRARIAN],
    ]);
    expect(topicId).toBe(tree.topics[0]?.id);
    expect(await db.library.topicOf('opportunity', opportunity.id)).toBe(topicId);
    expect(await work(first.id)).toEqual([{ outcome: 'done', subject_version: 1 }]);
    // Every new folder has its event, like any entity.
    const [events] = await db.sql<{ count: string }[]>`
      select count(*)::text as count from events where aggregate_type::text like 'library_%'
    `;
    expect(events?.count).toBe('3');
  });

  it('puts a pain about the same problem under the existing topic by its key', async () => {
    const similar = await painOf('Property managers struggle to track tenant repair requests');
    nextAnswer = answer('T1');
    await expect(run()).resolves.toBe('done');
    expect(await db.library.topicOf('pain', similar.id)).toBe(
      await db.library.topicOf('pain', first.id),
    );
    expect((await db.library.tree()).topics).toHaveLength(1);
    // The model saw the closest topic with what is filed there.
    expect(claude.calls.at(-1)?.prompt).toContain(
      'T1: Недвижимость › Арендодатели › Заявки на ремонт',
    );
  });

  it('records a bad answer once, files nothing and does not ask again', async () => {
    const odd = await painOf('Landlords cannot find reliable plumbers on weekends');
    nextAnswer = answer('new', 'Недвижимость', 'Аренда / ремонт', 'Сантехники');
    await expect(run()).resolves.toBe('done');
    expect(await db.library.topicOf('pain', odd.id)).toBeUndefined();
    expect(await work(odd.id)).toEqual([{ outcome: 'rejected', subject_version: 1 }]);
    const calls = claude.calls.length;
    await expect(run()).resolves.toBe('idle');
    expect(claude.calls).toHaveLength(calls);
  });

  it('counts what was filed for the digest', async () => {
    expect(await libraryDigestLine(db, Date.now())).toBe(
      '📚 Новое в библиотеке за сутки: 3 → /library',
    );
  });

  it('lets the owner add a folder and move a pain through the bot, as a new journal row', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/library add Недвижимость / Тетиев / Дом на Шевченко');
    expect(chat.last()?.text).toContain('📚 Создать: проект «Тетиев», тема «Дом на Шевченко»?');
    await chat.press(chat.buttons().find((data) => data.startsWith('lib:y:')) ?? '');
    expect(chat.last()?.text).toBe(
      '📚 Создано: Недвижимость › Тетиев › Дом на Шевченко. Смотреть — /library.',
    );

    // /library → the vertical → the topic of the pain → «Переложить».
    await chat.send('/library');
    expect(chat.last()?.text).toContain('📁 Недвижимость — тем 2, разложено 3');
    await chat.press(chat.buttons()[0] ?? '');
    const topicButtons = chat.buttons().filter((data) => data.startsWith('lib:t:'));
    expect(topicButtons).toHaveLength(2);
    await chat.press(topicButtons[0] ?? '');
    expect(chat.last()?.text).toContain('📄 Недвижимость › Арендодатели › Заявки на ремонт');
    const move = `lib:m:p:${first.id}`;
    expect(chat.buttons()).toContain(move);
    await chat.press(move);
    expect(chat.last()?.text).toContain('Выберите вертикаль.');
    await chat.press(chat.buttons().find((data) => data.startsWith('lib:mv:')) ?? '');
    const target = chat.buttons().find((data) => data.startsWith('lib:mt:') && data.endsWith(':1'));
    await chat.press(target ?? '');
    expect(chat.last()?.text).toContain('в «Недвижимость › Тетиев › Дом на Шевченко»?');
    const yes = chat.buttons().find((data) => data.startsWith('lib:y:')) ?? '';
    await chat.press(yes);
    expect(chat.last()?.text).toBe('↪️ Переложено в «Недвижимость › Тетиев › Дом на Шевченко».');

    const tree = await db.library.tree();
    const house = tree.topics.find((item) => item.name === 'Дом на Шевченко');
    expect(await db.library.topicOf('pain', first.id)).toBe(house?.id);
    const rows = await db.sql<{ actor_type: string }[]>`
      select actor_type from library_filings where object_id = ${first.id} order by id
    `;
    expect(rows.map((row) => row.actor_type)).toEqual(['agent', 'owner']);
    expect((await db.library.filings({ topicId: house?.id }))[0]?.byOwner).toBe(true);

    // The same press again changes nothing.
    await chat.press(yes);
    expect(chat.last()?.text).toContain('⌛ Подтверждение устарело.');
    expect(await db.sql`select 1 from library_filings where object_id = ${first.id}`).toHaveLength(
      2,
    );
  });

  it('shows the owner’s move to the librarian as an example', async () => {
    await painOf('Landlords forget when tenant leases end');
    nextAnswer = answer('T1');
    await run();
    expect(claude.calls.at(-1)?.prompt).toContain("The owner's moves:");
    expect(claude.calls.at(-1)?.prompt).toContain(
      '- Landlords lose track of tenant repair requests → Недвижимость › Тетиев › Дом на Шевченко',
    );
  });
});

describe('the library in the database (phase 35)', () => {
  it('keeps the filing journal append-only', async () => {
    const [topic] = (await db.library.tree()).topics;
    if (topic === undefined) throw new Error('no topic');
    await db.library.file({
      objectType: 'pain',
      objectId: uuidv7(),
      topicId: topic.id,
      actorType: 'owner',
      actorId: OWNER.id,
    });
    await expect(db.sql`update library_filings set actor_type = 'system'`).rejects.toThrow();
    await expect(db.sql`delete from library_filings`).rejects.toThrow();
  });

  it('keeps a name unique in its parent whatever its case', async () => {
    const vertical = (name: string) =>
      createLibraryVertical(name, {
        id: libraryVerticalIdSchema.parse(uuidv7()),
        actor: OWNER,
        at: now(),
      });
    await db.repositories.libraryVerticals.insert(vertical('Общепит'));
    await expect(db.repositories.libraryVerticals.insert(vertical('ОБЩЕПИТ'))).rejects.toThrow();
  });
});
