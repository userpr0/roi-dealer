import { describe, expect, it } from 'vitest';
import {
  MARKET_ANALYST,
  marketContextTask,
  RESEARCHER,
  researchQueryTask,
} from '@roi-dealer/agents';
import { redactNamesTask } from '@roi-dealer/ai-runtime';
import { JUDGES, judgeOpportunityTask } from '@roi-dealer/judges';
import { frameOpportunityTask, OPPORTUNITY_ANALYST } from '@roi-dealer/opportunities';
import { extractSignalTask, matchPainTask, PAIN_ANALYST } from '@roi-dealer/signals';
import { approvePrincipal, readMarketContext, toTimestamp } from '@roi-dealer/domain';
import {
  agentGolden,
  perfectMarketAnswer,
  perfectResearchAnswer,
} from '../../support/agent-answers.js';
import { judgeGolden, perfectJudgeAnswer } from '../../support/judge-answers.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER } from '../../support/domain.js';
import { promptText, startFakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { startFakeHackerNews } from '../../support/fake-hacker-news.js';
import { startService, type ServiceProcess } from '../../support/service-process.js';

/** The owner grants the Hacker News integration in /decisions, once the worker asked. */
async function grantHackerNews(
  test: TestDatabase,
  service: ServiceProcess,
  beforeGrant: () => void = () => undefined,
): Promise<void> {
  await service.waitForLog(
    (line) =>
      line['message'] === 'evidence collection skipped' && line['reason'] === 'access_not_active',
  );
  beforeGrant();
  const principal = await test.database.repositories.principals.getByActor({
    type: 'integration',
    id: 'source:hacker-news',
  });
  if (principal === undefined) throw new Error('the worker did not ask for access');
  await test.database.repositories.principals.update(
    approvePrincipal(principal, { actor: OWNER, at: toTimestamp(new Date()) }),
    OWNER,
  );
}

describe('worker process', () => {
  it('starts, emits heartbeats and stops gracefully on SIGTERM', async () => {
    const service = startService('apps/worker/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      WORKER_HEARTBEAT_INTERVAL_MS: '100',
    });

    try {
      await service.waitForLog((line) => line['message'] === 'worker started');
      await service.waitForLog((line) => line['message'] === 'worker heartbeat');

      service.child.kill('SIGTERM');

      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      const messages = service.logs.map((line) => line['message']);
      expect(messages).toEqual(expect.arrayContaining(['worker stopped', 'shutdown completed']));
      expect(service.logs.every((line) => line['service'] === 'worker')).toBe(true);
    } finally {
      service.kill();
    }
  });

  it('stops gracefully on SIGINT', async () => {
    const service = startService('apps/worker/src/main.ts', { NODE_ENV: 'test' });

    try {
      await service.waitForLog((line) => line['message'] === 'worker started');
      service.child.kill('SIGINT');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      service.kill();
    }
  });

  it('exits with code 1 on invalid configuration', async () => {
    const service = startService('apps/worker/src/main.ts', {
      WORKER_HEARTBEAT_INTERVAL_MS: 'soon',
    });

    await expect(service.waitForExit()).resolves.toMatchObject({ code: 1 });
    expect(JSON.stringify(service.logs)).toContain('WORKER_HEARTBEAT_INTERVAL_MS');
  });
});

describe('worker process with a database (PHASE 05)', () => {
  it('asks the owner for access, collects evidence after the grant and stops cleanly', async () => {
    const test = await createTestDatabase();
    const hn = await startFakeHackerNews();
    hn.publish([
      {
        id: 7,
        type: 'story',
        by: 'author_x',
        time: Math.floor(Date.now() / 1_000) - 60,
        title: 'Ask HN: How do you track client hours?',
        text: 'Call me at 555-123-4567 if you solved it',
      },
    ]);
    const service = startService('apps/worker/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: test.url,
      EVIDENCE_COLLECT_INTERVAL_MS: '200',
      HACKER_NEWS_API_URL: hn.baseUrl,
    });

    try {
      await service.waitForLog((line) => line['message'] === 'evidence collection scheduled');
      // Nothing is fetched before the grant.
      await grantHackerNews(test, service, () => expect(hn.requests).toEqual([]));

      await service.waitForLog((line) => line['message'] === 'evidence collected');
      const rows = await test.database.sql<{ excerpt: string }[]>`select excerpt from evidence`;
      expect(rows.map((row) => row.excerpt)).toEqual([
        'Ask HN: How do you track client hours?\n\nCall me at [phone] if you solved it',
      ]);

      service.child.kill('SIGTERM');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      const output = JSON.stringify(service.logs) + service.stderr();
      for (const secret of [test.url, '555-123-4567', 'author_x']) {
        expect(output).not.toContain(secret);
      }
    } finally {
      service.kill();
      await hn.close();
      await test.drop();
    }
  });
});

describe('worker process with AI providers (PHASE 09, 06, 07, 10)', () => {
  it('verifies models, runs evals, redacts names, finds pains, drafts an opportunity with its market', async () => {
    const test = await createTestDatabase();
    const hn = await startFakeHackerNews();
    const fakes = await Promise.all([
      startFakeAi('anthropic'),
      startFakeAi('openai'),
      startFakeAi('google'),
    ]);
    const [claude, gpt, gemini] = fakes;
    const golden = new Map(redactNamesTask.evalCases.map((c) => [c.input.text, c.expected]));
    const painGolden = new Map(extractSignalTask.evalCases.map((c) => [c.input.text, c.expected]));
    const matchGolden = new Map(
      matchPainTask.evalCases.map((c) => [matchPainTask.render(c.input), c.expected]),
    );
    const frameGolden = new Map(
      frameOpportunityTask.evalCases.map((c) => [frameOpportunityTask.render(c.input), c.expected]),
    );
    const agentsGolden = agentGolden();
    const judgesGolden = judgeGolden();
    const frame = (
      buyer: 'business' | 'consumer',
      recurring: boolean,
      paymentQuotes: readonly string[],
    ) => ({
      title: 'Invoices that get paid without chasing',
      summary: 'Small agencies lose days chasing late invoices.',
      icp: 'Agencies with 2–10 people',
      problem: 'Clients pay invoices late',
      change: 'Reminders and follow-ups run on their own',
      measurableResult: 'A day a week back',
      buyer,
      recurring,
      urgency: 'medium',
      serviceHeavy: false,
      paymentQuotes,
      pricingHypothesis: '$29 a month',
    });
    const noPain = {
      pain: false,
      statement: '',
      audience: '',
      outcome: '',
      strength: 'weak',
      quote: '',
    };
    const painOf = (statement: string, quote: string) => ({
      pain: true,
      statement,
      audience: 'Small agencies',
      outcome: 'Get paid on time',
      strength: 'moderate',
      quote,
    });
    const answer = (request: FakeAiRequest) => {
      const text = promptText(request.prompt);
      if (request.instructions === extractSignalTask.instructions) {
        const expected = painGolden.get(text);
        const output =
          expected !== undefined
            ? expected.pain
              ? painOf('Someone struggles with a costly problem here', text.slice(0, 40))
              : noPain
            : text.includes('chasing invoices')
              ? painOf('Small agencies struggle to get invoices paid', 'chasing invoices')
              : noPain;
        return { text: JSON.stringify(output) };
      }
      if (request.instructions === matchPainTask.instructions) {
        // Outside the golden set: the second invoice post is the same pain.
        return { text: JSON.stringify({ match: matchGolden.get(request.prompt) ?? 'P1' }) };
      }
      if (request.instructions === researchQueryTask.instructions) {
        const expected = agentsGolden.research.get(request.prompt);
        return {
          text: JSON.stringify(
            expected === undefined
              ? { queries: ['chasing invoices'] }
              : perfectResearchAnswer(expected),
          ),
        };
      }
      if (request.instructions === marketContextTask.instructions) {
        const expected = agentsGolden.market.get(request.prompt);
        // Outside the golden set: the excerpts of the prompt, quoted where they name money.
        const excerpts = [...request.prompt.matchAll(/^E\d+\. """([\s\S]*?)"""$/gm)].map(
          (match) => match[1] ?? '',
        );
        return {
          text: JSON.stringify(
            perfectMarketAnswer(
              expected ?? { alternatives: [['assistant']], amounts: [], excerpts },
            ),
          ),
        };
      }
      if (request.instructions === judgeOpportunityTask.instructions) {
        const expected = judgesGolden.get(request.prompt);
        return {
          text: JSON.stringify(
            expected === undefined
              ? {
                  score: 4,
                  rationale: 'Agencies already pay an assistant every month to chase invoices.',
                  evidence: [1],
                  concerns: [],
                }
              : perfectJudgeAnswer(expected),
          ),
        };
      }
      if (request.instructions === frameOpportunityTask.instructions) {
        const expected = frameGolden.get(request.prompt);
        const output =
          expected === undefined
            ? frame('business', true, ['We pay $300 a month'])
            : frame(
                expected.buyer,
                expected.recurring,
                expected.paying ? [(expected.excerpts.at(-1) ?? '').slice(0, 40)] : [],
              );
        return { text: JSON.stringify(output) };
      }
      const names = golden.get(text) ?? (text.includes('Sarah Chen') ? ['Sarah Chen'] : []);
      return { text: JSON.stringify({ names }) };
    };
    claude.listModels(['claude-haiku-5-5', 'claude-opus-5-5']);
    gpt.listModels(['gpt-5.4-mini', 'gpt-5.5']);
    gemini.listModels(['gemini-3.1-flash-lite', 'gemini-3.1-pro-preview']);
    for (const fake of fakes) fake.answer(answer);
    const keys = {
      ANTHROPIC_API_KEY: 'sk-ant-process-0123456789',
      OPENAI_API_KEY: 'sk-openai-process-0123456789',
      GEMINI_API_KEY: 'gemini-process-0123456789',
    };
    hn.publish([
      {
        id: 9,
        type: 'story',
        by: 'author_y',
        time: Math.floor(Date.now() / 1_000) - 60,
        title: 'Ask HN: Invoicing for a two-person agency?',
        text: 'My partner Sarah Chen spends Fridays chasing invoices',
      },
      {
        id: 10,
        type: 'story',
        by: 'author_z',
        time: Math.floor(Date.now() / 1_000) - 30,
        title: 'Ask HN: Anyone automated chasing invoices?',
        text: 'We pay $300 a month to an assistant just for chasing invoices',
      },
    ]);
    const service = startService('apps/worker/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: test.url,
      EVIDENCE_COLLECT_INTERVAL_MS: '200',
      SIGNALS_INTERVAL_MS: '200',
      OPPORTUNITIES_INTERVAL_MS: '200',
      JUDGES_INTERVAL_MS: '200',
      RESEARCH_INTERVAL_MS: '200',
      MARKET_INTERVAL_MS: '200',
      HACKER_NEWS_API_URL: hn.baseUrl,
      HACKER_NEWS_SEARCH_URL: hn.searchUrl,
      ...keys,
      ANTHROPIC_BASE_URL: claude.baseUrl,
      OPENAI_BASE_URL: gpt.baseUrl,
      GEMINI_BASE_URL: gemini.baseUrl,
    });

    try {
      const configured = await service.waitForLog(
        (line) => line['message'] === 'ai providers configured',
      );
      expect(configured['providers']).toEqual(['anthropic', 'openai', 'google']);
      await service.waitForLog((line) => line['message'] === 'ai models verified');
      // Evals first: a model without a passing report never runs a task.
      for (const task of [
        'redact-names',
        'extract-signal',
        'match-pain',
        'frame-opportunity',
        'research-query',
        'market-context',
      ]) {
        for (const model of ['claude-haiku-5-5', 'gemini-3.1-flash-lite', 'gpt-5.4-mini']) {
          await service.waitForLog(
            (line) =>
              line['message'] === 'ai eval passed' &&
              line['task'] === task &&
              line['model'] === model,
          );
        }
      }
      // The judges run on the strong models of all three providers (PHASE 11).
      for (const model of ['claude-opus-5-5', 'gemini-3.1-pro-preview', 'gpt-5.5']) {
        await service.waitForLog(
          (line) =>
            line['message'] === 'ai eval passed' &&
            line['task'] === 'judge-opportunity' &&
            line['model'] === model,
        );
      }
      // Every agent asks for its access too; the owner grants them and the source.
      for (const agent of [PAIN_ANALYST, OPPORTUNITY_ANALYST, RESEARCHER, MARKET_ANALYST, JUDGES]) {
        await service.waitForLog(
          (line) =>
            line['message'] === 'agent run' &&
            line['agent'] === agent.id &&
            line['outcome'] === 'no_access',
        );
        const principal = await test.database.repositories.principals.getByActor(agent);
        if (principal === undefined) throw new Error(`${agent.id} did not ask for access`);
        await test.database.repositories.principals.update(
          approvePrincipal(principal, { actor: OWNER, at: toTimestamp(new Date()) }),
          OWNER,
        );
      }
      await grantHackerNews(test, service);
      await service.waitForLog((line) => line['message'] === 'evidence collected');
      const rows = await test.database.sql<{ excerpt: string }[]>`
        select excerpt from evidence order by external_id
      `;
      expect(rows.map((row) => row.excerpt)).toEqual([
        'Ask HN: Anyone automated chasing invoices?\n\nWe pay $300 a month to an assistant just for chasing invoices',
        'Ask HN: Invoicing for a two-person agency?\n\nMy partner [name] spends Fridays chasing invoices',
      ]);
      await service.waitForLog(
        (line) => line['message'] === 'pain analysis' && line['signals'] === 2,
      );
      const pains = await test.database.repositories.pains.listByStatus('candidate');
      expect(pains).toMatchObject([
        { title: 'Small agencies struggle to get invoices paid', createdBy: PAIN_ANALYST },
      ]);
      expect(pains[0]?.signalIds).toHaveLength(2);
      await service.waitForLog(
        (line) => line['message'] === 'opportunity assessment' && line['opportunities'] === 1,
      );
      // A draft, or already judged and in front of the owner.
      const drafted = [
        ...(await test.database.repositories.opportunities.listByStatus('draft')),
        ...(await test.database.repositories.opportunities.listByStatus('under_review')),
      ];
      expect(drafted).toMatchObject([
        {
          title: 'Invoices that get paid without chasing',
          businessModel: { model: 'subscription' },
          createdBy: OPPORTUNITY_ANALYST,
        },
      ]);
      // The market context of the draft, quoted from its evidence.
      await service.waitForLog(
        (line) => line['message'] === 'market context' && line['stored'] === 1,
      );
      const [market] = await test.database.repositories.knowledgeAssets.listByTags([
        'market-context',
      ]);
      expect(market === undefined ? undefined : readMarketContext(market)).toMatchObject({
        money: [{ amountUsd: 300, period: 'month' }],
      });
      // Six judgements, then the owner's review queue.
      await service.waitForLog((line) => line['message'] === 'judges' && line['submitted'] === 1);
      const [judged] = await test.database.repositories.opportunities.listByStatus('under_review');
      expect(judged?.title).toBe('Invoices that get paid without chasing');
      const panel =
        judged === undefined
          ? undefined
          : (await test.database.judgements.latest([judged.id])).get(judged.id);
      expect(panel?.map((item) => [item.criterion, item.score])).toEqual([
        ['market', 4],
        ['pain_value', 4],
        ['economics', 4],
        ['buildability', 4],
        ['risk', 4],
        ['reuse', 4],
      ]);
      // The research agent searched HN for the pain while it had fewer than 3 signals.
      expect(hn.searches).toContain('chasing invoices');
      const tasks = await test.database.aiCalls.list({ limit: 1_000 });
      expect(
        new Set(tasks.filter((call) => call.purpose === 'task').map((call) => call.task)),
      ).toEqual(
        new Set([
          'redact-names',
          'extract-signal',
          'match-pain',
          'frame-opportunity',
          'research-query',
          'market-context',
          'judge-opportunity',
        ]),
      );

      service.child.kill('SIGTERM');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      const output = JSON.stringify(service.logs) + service.stderr();
      for (const secret of [
        ...Object.values(keys),
        test.url,
        'Sarah Chen',
        'author_y',
        '$300 a month',
      ]) {
        expect(output).not.toContain(secret);
      }
    } finally {
      service.kill();
      await Promise.all([hn.close(), ...fakes.map((fake) => fake.close())]);
      await test.drop();
    }
  });
});
