import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_TASKS,
  createAgentScheduler,
  MARKET_ANALYST,
  marketAnalystAgent,
  marketContextTask,
  RESEARCHER,
  researcherAgent,
  researchQueryTask,
  runAgent,
  type AgentDefinition,
  type MarketContextOutput,
} from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import { agentsText, ensureAccessRequest, opportunitiesText } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  createEvidence,
  createOpportunity,
  createPain,
  createSignal,
  evidenceIdSchema,
  opportunityIdSchema,
  painIdSchema,
  pauseSystem,
  reactivatePrincipal,
  readMarketContext,
  resumeSystem,
  suspendPrincipal,
  signalIdSchema,
  toTimestamp,
  type Actor,
  type Evidence,
  type Opportunity,
  type Pain,
  type Source,
  type SystemControl,
} from '@roi-dealer/domain';
import {
  collectEvidence,
  createHackerNewsSearchConnector,
  ensureConnection,
  integrationActor,
  SOURCE_CATALOG,
} from '@roi-dealer/evidence';
import { uuidv7 } from '@roi-dealer/shared';
import {
  agentGolden,
  perfectMarketAnswer,
  perfectResearchAnswer,
} from '../../support/agent-answers.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM } from '../../support/domain.js';
import { startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { startFakeHackerNews, type FakeHackerNews } from '../../support/fake-hacker-news.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let hn: FakeHackerNews;
let runtime: AiRuntime;
let hackerNews: Source;
const { logger, records } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());
const golden = agentGolden();

/** Queries and market answers the fake model gives outside the golden sets. */
let researchQueries: readonly string[] = ['reconcile stripe payouts'];
let marketOutput: MarketContextOutput = { alternatives: [], money: [], buyers: [] };

function oracle(request: FakeAiRequest) {
  if (request.instructions === researchQueryTask.instructions) {
    const expected = golden.research.get(request.prompt);
    return {
      text: JSON.stringify(
        expected === undefined ? { queries: researchQueries } : perfectResearchAnswer(expected),
      ),
    };
  }
  if (request.instructions === marketContextTask.instructions) {
    const expected = golden.market.get(request.prompt);
    return {
      text: JSON.stringify(expected === undefined ? marketOutput : perfectMarketAnswer(expected)),
    };
  }
  return { status: 400 };
}

function context(agent: AgentDefinition) {
  return runAgent(agent, {
    database: db,
    logger,
    runtime,
    ensureAccess: ensureAccessRequest,
    now: Date.now,
    signal: new AbortController().signal,
  });
}

const research = () =>
  researcherAgent({ search: createHackerNewsSearchConnector({ baseUrl: hn.searchUrl }) });

async function grant(actor: Actor): Promise<void> {
  const principal = await db.repositories.principals.getByActor(actor);
  if (principal === undefined) throw new Error(`${actor.id} did not ask for access`);
  await db.repositories.principals.update(
    approvePrincipal(principal, { actor: OWNER, at: now() }),
    OWNER,
  );
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

async function evidenceOf(text: string, externalId = String(Math.floor(Math.random() * 1e9))) {
  const evidence = createEvidence(
    { sourceId: hackerNews.id, kind: 'post', excerpt: text, observedAt: now(), externalId },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  return evidence;
}

async function painOf(title: string, evidence: Evidence): Promise<Pain> {
  const signal = createSignal(
    {
      title,
      summary: title,
      evidenceIds: [evidence.id],
      markets: ['US'],
      strength: 'moderate',
    },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.signals.insert(signal);
  const pain = createPain(
    {
      title,
      description: title,
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
  return pain;
}

async function opportunityOf(pain: Pain): Promise<Opportunity> {
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
  return opportunity;
}

const work = (agent: string) =>
  db.sql<{ outcome: string; subject_version: number; result: Record<string, unknown> }[]>`
    select outcome, subject_version, result from agent_work where agent = ${agent} order by id
  `;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  hn = await startFakeHackerNews();
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [createAnthropicProvider({ apiKey: 'sk-ant-agents-test', baseUrl: claude.baseUrl })],
    timeoutMs: 5_000,
  });
  // The Hacker News source the way the evidence engine connects it, granted by the owner.
  hackerNews = (
    await ensureConnection('hacker-news', {
      database: db,
      logger,
      ensureAccess: ensureAccessRequest,
    })
  ).source;
  await grant(integrationActor({ key: 'hacker-news' }));
});

afterAll(async () => {
  await Promise.all([claude.close(), hn.close()]);
  await test.drop();
});

beforeEach(() => {
  claude.answer(oracle);
});

describe('one runner for every agent (PHASE 10)', () => {
  it('does nothing at all while the kill switch is on', async () => {
    await setKillSwitch(true);
    await expect(context(research())).resolves.toBe('paused');
    await setKillSwitch(false);
    expect(await db.sql`select 1 from agent_runs`).toHaveLength(0);
    expect(await db.repositories.principals.getByActor(RESEARCHER)).toBeUndefined();
    expect(claude.calls).toEqual([]);
  });

  it('asks the owner for access first and journals the run', async () => {
    await expect(context(research())).resolves.toBe('no_access');
    await expect(context(marketAnalystAgent())).resolves.toBe('no_access');
    const requests = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(requests.map((item) => item.title)).toEqual(
      expect.arrayContaining(['Доступ: Агент исследований', 'Доступ: Агент рыночного контекста']),
    );
    const latest = await db.agentRuns.latest();
    expect(latest.get('researcher')).toMatchObject({ outcome: 'no_access', processed: 0 });
    expect(claude.calls).toEqual([]);
    expect(await agentsText(db, Date.now())).toContain(
      'Агент исследований — ⏳ ждёт вашего решения в /decisions',
    );
  });

  it('runs both new tasks only after their evals passed', async () => {
    await grant(RESEARCHER);
    await grant(MARKET_ANALYST);
    const reports = await runtime.evaluateMissing(AGENT_TASKS);
    expect(reports.map((report) => [report.task, report.score.passed])).toEqual([
      ['research-query', true],
      ['market-context', true],
    ]);
  });

  it('schedules each agent once and refuses the same agent twice', async () => {
    const scheduler = createAgentScheduler({
      database: db,
      logger,
      runtime,
      ensureAccess: ensureAccessRequest,
      agents: [
        { agent: research(), intervalMs: 60_000 },
        { agent: marketAnalystAgent(), intervalMs: 60_000 },
      ],
    });
    // Nothing to work on yet.
    await expect(scheduler.runOnce()).resolves.toEqual(
      new Map([
        ['researcher', 'idle'],
        ['market-analyst', 'idle'],
      ]),
    );
    scheduler.start();
    await scheduler.stop();
    expect(() =>
      createAgentScheduler({
        database: db,
        logger,
        runtime,
        ensureAccess: ensureAccessRequest,
        agents: [
          { agent: research(), intervalMs: 1 },
          { agent: research(), intervalMs: 1 },
        ],
      }),
    ).toThrow('scheduled twice');
  });
});

describe('the research agent finds more posts about a pain (PHASE 10)', () => {
  let pain: Pain;

  it('searches HN with a checked query and stores new posts through the evidence engine', async () => {
    const known = await evidenceOf(
      'Ask HN: How do you reconcile Stripe payouts with QuickBooks?',
      '501',
    );
    pain = await painOf('Small agencies reconcile Stripe payouts by hand', known);
    const time = Math.floor(Date.now() / 1_000) - 3_600;
    hn.publish(
      [
        {
          id: 501,
          type: 'story',
          by: 'author_a',
          time,
          title: 'Ask HN: How do you reconcile Stripe payouts with QuickBooks?',
        },
        {
          id: 502,
          type: 'story',
          by: 'author_b',
          time,
          title: 'Ask HN: Stripe payouts never match our books',
          text: 'Our bookkeeper (mail me at jane@example.com) spends Fridays on it.',
        },
        {
          id: 503,
          type: 'story',
          by: 'author_c',
          time,
          title: 'Ask HN: Reconciling payouts for a small agency?',
        },
      ],
      [],
    );
    hn.answerSearch((query) => (query === 'reconcile stripe payouts' ? [501, 502, 503] : []));
    researchQueries = ['"reconcile" Stripe payouts!'];

    await expect(context(research())).resolves.toBe('done');
    expect(hn.searches).toEqual(['reconcile stripe payouts']);
    const [row] = await work('researcher');
    expect(row).toMatchObject({
      outcome: 'done',
      subject_version: pain.version,
      result: { query: 'reconcile stripe payouts', evidence: 2 },
    });
    const stored = await db.sql<{ external_id: string; excerpt: string }[]>`
      select external_id, excerpt from evidence where source_id = ${hackerNews.id}
      order by external_id
    `;
    // The known post is skipped; contacts are redacted; authors are never stored.
    expect(stored).toEqual([
      {
        external_id: '501',
        excerpt: 'Ask HN: How do you reconcile Stripe payouts with QuickBooks?',
      },
      {
        external_id: '502',
        excerpt:
          'Ask HN: Stripe payouts never match our books\n\nOur bookkeeper (mail me at [email]) spends Fridays on it.',
      },
      { external_id: '503', excerpt: 'Ask HN: Reconciling payouts for a small agency?' },
    ]);
    expect(JSON.stringify(stored)).not.toContain('author_');
    const [snapshot] = await db.sql<{ request_url: string }[]>`
      select request_url from source_snapshots order by fetched_at desc limit 1
    `;
    expect(snapshot?.request_url).toContain('query=reconcile+stripe+payouts');
    expect(snapshot?.request_url).toContain('tags=ask_hn');
  });

  it('researches each pain version once, and records empty and rejected searches', async () => {
    await expect(context(research())).resolves.toBe('idle');
    await painOf('Freelancers chase late invoices', await evidenceOf('Ask HN: late invoices?'));
    researchQueries = ['late invoices'];
    await expect(context(research())).resolves.toBe('done');
    await painOf('Teams fight noisy alerts', await evidenceOf('Ask HN: noisy alerts?'));
    researchQueries = ['?!', 'alerts'];
    await expect(context(research())).resolves.toBe('done');
    const rows = await work('researcher');
    expect(rows.slice(1).map((row) => [row.outcome, row.result])).toEqual([
      ['empty', { query: 'late invoices', evidence: 0 }],
      ['rejected', {}],
    ]);
    expect(hn.searches).toEqual(['reconcile stripe payouts', 'late invoices']);
  });

  it('refuses a search on a source whose catalog entry has no search', async () => {
    const catalog = SOURCE_CATALOG.map((entry) =>
      entry.key === 'hacker-news'
        ? { ...entry, access: { ...entry.access, searchEndpoint: undefined } }
        : entry,
    );
    const searches = hn.searches.length;
    await expect(
      collectEvidence(createHackerNewsSearchConnector({ baseUrl: hn.searchUrl }), {
        database: db,
        logger,
        catalog,
        query: 'late invoices',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(hn.searches).toHaveLength(searches);
  });

  it('searches nothing while the source is not granted', async () => {
    const source = await db.repositories.principals.getByActor(
      integrationActor({ key: 'hacker-news' }),
    );
    if (source === undefined) throw new Error('no source principal');
    await painOf('Landlords chase rent', await evidenceOf('Ask HN: chasing rent?'));
    const suspended = suspendPrincipal(source, { actor: OWNER, at: now() });
    await db.repositories.principals.update(suspended, OWNER);
    const calls = claude.calls.length;
    await expect(context(research())).resolves.toBe('no_access');
    expect(claude.calls).toHaveLength(calls);
    expect(records).toContainEqual(
      expect.objectContaining({ message: 'research skipped: the source is not granted' }),
    );
    await db.repositories.principals.update(
      reactivatePrincipal(suspended, { actor: OWNER, at: now() }),
      OWNER,
    );
  });
});

describe('the market context agent keeps only quoted facts (PHASE 10)', () => {
  let opportunity: Opportunity;

  it('stores alternatives, money and buyers with quotes as a Brain entry', async () => {
    const pain = await painOf(
      'Agencies pay bookkeepers to match payouts',
      await evidenceOf('We pay a bookkeeper $400 a month mostly to match payouts by hand.'),
    );
    opportunity = await opportunityOf(pain);
    marketOutput = {
      alternatives: [
        {
          name: 'Bookkeeper',
          kind: 'service',
          quote: 'We pay a bookkeeper $400 a month',
          excerpt: 1,
        },
        {
          name: 'Xero',
          kind: 'product',
          quote: 'We moved to Xero and it fixed everything',
          excerpt: 1,
        },
      ],
      money: [
        { period: 'year', quote: 'We pay a bookkeeper $400 a month', excerpt: 1 },
        { period: 'month', quote: 'Our accountant charges $900', excerpt: 2 },
      ],
      buyers: [{ role: 'agency owner', quote: 'We pay a bookkeeper', excerpt: 1 }],
    };

    await expect(context(marketAnalystAgent())).resolves.toBe('done');
    const [row] = await work('market-analyst');
    expect(row).toMatchObject({
      outcome: 'done',
      result: { alternatives: 1, money: 1, buyers: 1 },
    });
    const [entry] = await db.repositories.knowledgeAssets.listByTags(['market-context'], {
      opportunityIds: [opportunity.id],
    });
    expect(entry).toMatchObject({
      kind: 'market_data',
      title: 'Market context: Automatic payout reconciliation for agencies',
      links: { opportunityId: opportunity.id },
      createdBy: MARKET_ANALYST,
    });
    const market = entry === undefined ? undefined : readMarketContext(entry);
    expect(market?.money).toEqual([expect.objectContaining({ amountUsd: 400, period: 'month' })]);
    expect(market?.alternatives.map((item) => item.name)).toEqual(['Bookkeeper']);
    expect(entry?.links.evidenceIds).toEqual([market?.money[0]?.evidenceId]);

    const text = await opportunitiesText(db.repositories, db.opportunityAssessments, db.judgements);
    expect(text).toContain(
      '   Рынок: сейчас — Bookkeeper · суммы — $400/мес · платит — agency owner',
    );
  });

  it('works on each opportunity version once and stores nothing unconfirmed', async () => {
    await expect(context(marketAnalystAgent())).resolves.toBe('idle');
    const other = await opportunityOf(
      await painOf(
        'Teams lose decisions in chat',
        await evidenceOf('We lose decisions in Slack threads.'),
      ),
    );
    marketOutput = {
      alternatives: [
        { name: 'Confluence', kind: 'product', quote: 'Confluence is our wiki', excerpt: 1 },
      ],
      money: [],
      buyers: [],
    };
    await expect(context(marketAnalystAgent())).resolves.toBe('done');
    const rows = await work('market-analyst');
    expect(rows.at(-1)).toMatchObject({ outcome: 'empty' });
    expect(
      await db.repositories.knowledgeAssets.listByTags(['market-context'], {
        opportunityIds: [other.id],
      }),
    ).toEqual([]);
  });

  it('stops on an unavailable model and shows every agent in /agents', async () => {
    await opportunityOf(
      await painOf('Clinics lose no-shows', await evidenceOf('No-shows cost us $200 each.')),
    );
    claude.answer(() => ({ status: 529 }));
    await expect(context(marketAnalystAgent())).resolves.toBe('stopped');
    const latest = await db.agentRuns.latest();
    expect(latest.get('market-analyst')).toMatchObject({ outcome: 'stopped', stoppedBy: 'failed' });

    const text = await agentsText(db, Date.now());
    // The test database already has one agent of its own.
    expect(text).toMatch(/^🤖 Агенты · 3\n/);
    expect(text).toContain('Агент исследований — ✅ работает');
    expect(text).toContain('Агент рыночного контекста — ✅ работает');
    expect(text).toContain('остановлен: все модели ответили с ошибкой');
    expect(text).toMatch(/За сутки: запусков \d+, обработано \d+/);
    expect(JSON.stringify(records)).not.toContain('bookkeeper $400');
    expect(JSON.stringify(records)).not.toContain('jane@example.com');
  });
});
