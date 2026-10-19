import { describe, expect, it } from 'vitest';
import {
  AGENT_TASKS,
  cleanQuery,
  failureCode,
  marketContextTask,
  marketSummary,
  MAX_MARKET_EXCERPTS,
  parseUsd,
  periodOf,
  researchQueryTask,
  scoreMarketContext,
  scoreResearchQuery,
  storedContext,
  toMarketContext,
  toSearchQuery,
} from '@roi-dealer/agents';
import {
  AI_TASKS,
  callCostMicroUsd,
  EVAL_DAILY_SHARE,
  MIN_EVAL_CASES,
  MODEL_REGISTRY,
} from '@roi-dealer/ai-runtime';
import { agentsText, marketLine, NO_AGENTS_TEXT } from '@roi-dealer/command-center';
import {
  createKnowledgeAsset,
  evidenceIdSchema,
  knowledgeAssetIdSchema,
  readMarketContext,
  toTimestamp,
  type Evidence,
} from '@roi-dealer/domain';
import { createHackerNewsSearchConnector, SOURCE_CATALOG } from '@roi-dealer/evidence';
import { OPPORTUNITY_TASKS } from '@roi-dealer/opportunities';
import { SIGNAL_TASKS } from '@roi-dealer/signals';
import { uuidv7 } from '@roi-dealer/shared';
import { perfectMarketAnswer, perfectResearchAnswer } from '../../support/agent-answers.js';
import { SYSTEM } from '../../support/domain.js';

const bulkModels = MODEL_REGISTRY.filter((model) => model.tier === 'bulk');

describe('research queries are plain words only (PHASE 10)', () => {
  it('keeps 2–5 lowercase words of letters and digits', () => {
    expect(cleanQuery('Stripe payout reconciliation')).toBe('stripe payout reconciliation');
    expect(cleanQuery('"late" invoice -payments OR')).toBe('late invoice payments or');
    expect(cleanQuery('late invoice site:example.com and more')).toBeUndefined();
    expect(cleanQuery('  on-call   alerts ')).toBe('on call alerts');
    expect(cleanQuery('invoices')).toBeUndefined();
    expect(cleanQuery('one two three four five six')).toBeUndefined();
    expect(cleanQuery('счета клиентов')).toBeUndefined();
    expect(cleanQuery(`${'a'.repeat(40)} ${'b'.repeat(30)}`)).toBeUndefined();
  });

  it('takes the first usable of at most three proposed queries', () => {
    expect(toSearchQuery({ queries: ['?', 'x', 'late invoices', 'flaky tests'] })).toBe(
      'late invoices',
    );
    expect(toSearchQuery({ queries: ['?', '!', '#', 'late invoices'] })).toBeUndefined();
    expect(toSearchQuery({ queries: [] })).toBeUndefined();
  });

  it('has a golden set that perfect answers pass and off-topic answers fail', () => {
    const { evalCases } = researchQueryTask;
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    for (const testCase of evalCases) {
      expect(researchQueryTask.input.safeParse(testCase.input).success).toBe(true);
    }
    const perfect = evalCases.map((c) => ({
      expected: c.expected,
      output: perfectResearchAnswer(c.expected),
    }));
    expect(scoreResearchQuery(perfect)).toEqual({
      passed: true,
      metrics: { valid: 1, relevant: 1, answered: 1 },
    });
    const offTopic = evalCases.map((c) => ({
      expected: c.expected,
      output: { queries: ['best laptop deals'] },
    }));
    expect(scoreResearchQuery(offTopic)).toMatchObject({ passed: false });
    const broken = evalCases.map((c) => ({ expected: c.expected, output: { queries: ['?!'] } }));
    expect(scoreResearchQuery(broken).metrics['valid']).toBe(0);
  });
});

describe('market context is quoted evidence only (PHASE 10, §2.5, §2.13)', () => {
  const excerpts = [
    'We export Stripe payouts to a Google Sheet and our bookkeeper matches them every Friday.',
    'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
  ];

  it('reads amounts and periods from the quote itself', () => {
    expect(parseUsd('We pay $400 a month')).toBe(400);
    expect(parseUsd('TaxJar would cost us $1,200 a year')).toBe(1_200);
    expect(parseUsd('$14.99 a month')).toBe(14.99);
    expect(parseUsd('NetSuite is $25k a year')).toBe(25_000);
    expect(parseUsd('about $1.5k')).toBe(1_500);
    expect(parseUsd('$5 million')).toBe(5);
    expect(parseUsd('8-10% of rent')).toBeUndefined();
    expect(parseUsd('400 a month')).toBeUndefined();
    expect(periodOf('$41 per user per month', 'unknown')).toBe('month');
    expect(periodOf('$25 an hour', 'unknown')).toBe('hour');
    expect(periodOf('$300 of produce a week', 'month')).toBe('week');
    expect(periodOf('$1,200 a year', 'month')).toBe('year');
    expect(periodOf('quoted $8,000 to set it up', 'one_time')).toBe('one_time');
  });

  it('keeps an item only when its quote is in the excerpt it names', () => {
    const context = toMarketContext(excerpts, {
      alternatives: [
        {
          name: 'Google Sheet',
          kind: 'manual',
          quote: 'to a Google Sheet and our bookkeeper',
          excerpt: 1,
        },
        // The same name twice counts once.
        {
          name: 'google sheet',
          kind: 'manual',
          quote: 'to a Google Sheet and our bookkeeper',
          excerpt: 1,
        },
        // Invented, and a real quote under the wrong excerpt.
        { name: 'Xero', kind: 'product', quote: 'We switched to Xero last year', excerpt: 1 },
        {
          name: 'Bookkeeper',
          kind: 'service',
          quote: 'We pay a bookkeeper $400 a month',
          excerpt: 1,
        },
        {
          name: 'Bookkeeper',
          kind: 'service',
          quote: 'We pay a bookkeeper $400 a month',
          excerpt: 9,
        },
      ],
      money: [
        // The model's period is replaced by the quote's, the amount always comes from the quote.
        { period: 'year', quote: '"We pay a bookkeeper $400 a month"', excerpt: 2 },
        { period: 'month', quote: 'mostly to match payouts by hand', excerpt: 2 },
      ],
      buyers: [{ role: 'agency owner', quote: 'We pay a bookkeeper', excerpt: 2 }],
    });
    expect(context).toEqual({
      alternatives: [
        {
          name: 'Google Sheet',
          kind: 'manual',
          quote: 'to a Google Sheet and our bookkeeper',
          excerpt: 0,
        },
      ],
      money: [
        { amountUsd: 400, period: 'month', quote: 'We pay a bookkeeper $400 a month', excerpt: 1 },
      ],
      buyers: [{ role: 'agency owner', quote: 'We pay a bookkeeper', excerpt: 1 }],
    });
    expect(marketSummary(context)).toBe(
      [
        'Alternatives in use: Google Sheet (manual).',
        'Money mentioned: $400 a month.',
        'Who pays or decides: agency owner.',
      ].join('\n'),
    );
  });

  it('stores the context with evidence ids and reads it back from the Brain entry', () => {
    const evidence = excerpts.map(
      (excerpt) => ({ id: evidenceIdSchema.parse(uuidv7()), excerpt }) as unknown as Evidence,
    );
    const context = toMarketContext(
      excerpts,
      perfectMarketAnswer({
        alternatives: [['sheet'], ['bookkeeper']],
        amounts: [400],
        excerpts,
      }),
    );
    const body = storedContext(context, evidence);
    expect(body.money).toEqual([
      expect.objectContaining({ amountUsd: 400, evidenceId: evidence[1]?.id }),
    ]);
    const asset = createKnowledgeAsset(
      {
        kind: 'market_data',
        title: 'Market context: Payout reconciliation',
        summary: marketSummary(context),
        body: JSON.stringify(body),
        links: { evidenceIds: evidence.map((item) => item.id) },
        tags: ['market-context'],
      },
      { id: knowledgeAssetIdSchema.parse(uuidv7()), actor: SYSTEM, at: toTimestamp(new Date()) },
    );
    expect(readMarketContext(asset)).toEqual(body);
    expect(readMarketContext({ ...asset, tags: ['eval'] })).toBeUndefined();
    expect(readMarketContext({ ...asset, body: '{"version":2}' })).toBeUndefined();
    expect(readMarketContext({ ...asset, body: 'not json' })).toBeUndefined();
    expect(marketLine(body)).toBe('   Рынок: сейчас — sheet, bookkeeper · суммы — $400/мес');
  });

  it('has a golden set that perfect answers pass and invented ones fail', () => {
    const { evalCases } = marketContextTask;
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    for (const testCase of evalCases) {
      expect(marketContextTask.input.safeParse(testCase.input).success).toBe(true);
    }
    // Cases without money keep the model honest about amounts.
    expect(evalCases.filter((c) => c.expected.amounts.length === 0).length).toBeGreaterThanOrEqual(
      5,
    );
    const perfect = evalCases.map((c) => ({
      expected: c.expected,
      output: perfectMarketAnswer(c.expected),
    }));
    expect(scoreMarketContext(perfect)).toEqual({
      passed: true,
      metrics: { alternatives: 1, money: 1, grounded: 1, answered: 1 },
    });
    const invented = evalCases.map((c) => ({
      expected: c.expected,
      output: {
        ...perfectMarketAnswer(c.expected),
        alternatives: [
          {
            name: 'Acme Suite',
            kind: 'product' as const,
            quote: 'Acme Suite costs $99',
            excerpt: 1,
          },
        ],
        money: [{ period: 'month' as const, quote: 'Acme Suite costs $99', excerpt: 1 }],
      },
    }));
    expect(scoreMarketContext(invented)).toMatchObject({ passed: false });
  });
});

describe('AI budget of the agents (D-021)', () => {
  it('keeps the shares of all tasks with evals within 1', () => {
    const tasks = [...AI_TASKS, ...SIGNAL_TASKS, ...OPPORTUNITY_TASKS, ...AGENT_TASKS];
    expect(new Set(tasks.map((task) => task.name)).size).toBe(tasks.length);
    expect(tasks.reduce((sum, task) => sum + task.dailyShare, EVAL_DAILY_SHARE)).toBeCloseTo(0.7);
  });

  it('reserves at least the worst-case cost of one call on every bulk model', () => {
    const worst = {
      'research-query': researchQueryTask.instructions.length + 2_300,
      'market-context': marketContextTask.instructions.length + MAX_MARKET_EXCERPTS * 1_010 + 2_300,
    };
    for (const task of AGENT_TASKS) {
      for (const model of bulkModels) {
        expect(
          callCostMicroUsd(model, worst[task.name as keyof typeof worst], task.maxOutputTokens),
        ).toBeLessThanOrEqual(task.maxCostMicroUsd);
      }
    }
  });
});

describe('/agents (PHASE 10)', () => {
  it('explains where agents come from while there are none', async () => {
    const none = () => Promise.resolve([]);
    const database = {
      repositories: { principals: { listByStatus: none } },
      agentRuns: {
        latest: () => Promise.resolve(new Map()),
        totals: () => Promise.resolve(new Map()),
      },
      aiCalls: { spend: () => Promise.resolve({ costMicroUsd: 0, calls: 0, failed: 0 }) },
    } as unknown as Parameters<typeof agentsText>[0];
    await expect(agentsText(database, Date.now())).resolves.toBe(NO_AGENTS_TEXT);
  });
});

describe('the research source (PHASE 10, §2.21)', () => {
  it('searches Hacker News only within its catalog limits', () => {
    const hn = SOURCE_CATALOG.find((entry) => entry.key === 'hacker-news');
    expect(hn?.access.searchEndpoint).toBe('https://hn.algolia.com/api/v1');
    expect(hn?.limits.maxItemsPerSearch).toBe(10);
    expect(hn?.terms.conditions.join(' ')).toContain('HN Search API');
    // No other source can be searched yet.
    expect(
      SOURCE_CATALOG.filter((entry) => entry.access.searchEndpoint !== undefined).map(
        (entry) => entry.key,
      ),
    ).toEqual(['hacker-news']);
  });

  it('never sends a search without words or with a long query', async () => {
    const search = createHackerNewsSearchConnector({ baseUrl: 'http://127.0.0.1:9' });
    const request = { maxItems: 10, known: () => Promise.resolve(new Set<string>()) };
    for (const query of [undefined, '   ', 'x'.repeat(61)]) {
      await expect(search.fetch({ ...request, query })).rejects.toMatchObject({
        code: 'bad_request',
      });
    }
  });

  it('journals errors by a short code, never by their message', () => {
    expect(failureCode(Object.assign(new Error('secret text'), { code: 'fetch_failed' }))).toBe(
      'fetch_failed',
    );
    expect(failureCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      'econnrefused',
    );
    expect(failureCode(new Error('the post said something'))).toBe('error');
  });
});
