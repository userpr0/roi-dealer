import { describe, expect, it } from 'vitest';
import { redactNamesTask } from '@roi-dealer/ai-runtime';
import { extractSignalTask, matchPainTask, PAIN_ANALYST } from '@roi-dealer/signals';
import { approvePrincipal, toTimestamp } from '@roi-dealer/domain';
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

describe('worker process with AI providers (PHASE 09, 06)', () => {
  it('verifies models, runs evals, redacts names and finds pains in new evidence', async () => {
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
              ? painOf(
                  'Small agencies struggle to get invoices paid',
                  'spends Fridays chasing invoices',
                )
              : noPain;
        return { text: JSON.stringify(output) };
      }
      if (request.instructions === matchPainTask.instructions) {
        return { text: JSON.stringify({ match: matchGolden.get(request.prompt) ?? 'none' }) };
      }
      const names = golden.get(text) ?? (text.includes('Sarah Chen') ? ['Sarah Chen'] : []);
      return { text: JSON.stringify({ names }) };
    };
    claude.listModels(['claude-haiku-5-5']);
    gpt.listModels(['gpt-5.4-mini']);
    gemini.listModels(['gemini-3.1-flash-lite']);
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
    ]);
    const service = startService('apps/worker/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: test.url,
      EVIDENCE_COLLECT_INTERVAL_MS: '200',
      SIGNALS_INTERVAL_MS: '200',
      HACKER_NEWS_API_URL: hn.baseUrl,
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
      for (const task of ['redact-names', 'extract-signal', 'match-pain']) {
        for (const model of ['claude-haiku-5-5', 'gemini-3.1-flash-lite', 'gpt-5.4-mini']) {
          await service.waitForLog(
            (line) =>
              line['message'] === 'ai eval passed' &&
              line['task'] === task &&
              line['model'] === model,
          );
        }
      }
      // The pain analyst asks for its access too; the owner grants both.
      await service.waitForLog(
        (line) =>
          line['message'] === 'pain analysis skipped' && line['reason'] === 'access_not_active',
      );
      const analyst = await test.database.repositories.principals.getByActor(PAIN_ANALYST);
      if (analyst === undefined) throw new Error('the pain analyst did not ask for access');
      await test.database.repositories.principals.update(
        approvePrincipal(analyst, { actor: OWNER, at: toTimestamp(new Date()) }),
        OWNER,
      );
      await grantHackerNews(test, service);
      await service.waitForLog((line) => line['message'] === 'evidence collected');
      const rows = await test.database.sql<{ excerpt: string }[]>`select excerpt from evidence`;
      expect(rows.map((row) => row.excerpt)).toEqual([
        'Ask HN: Invoicing for a two-person agency?\n\nMy partner [name] spends Fridays chasing invoices',
      ]);
      await service.waitForLog(
        (line) => line['message'] === 'pain analysis' && line['signals'] === 1,
      );
      const pains = await test.database.repositories.pains.listByStatus('candidate');
      expect(pains).toMatchObject([
        { title: 'Small agencies struggle to get invoices paid', createdBy: PAIN_ANALYST },
      ]);
      const tasks = await test.database.aiCalls.list({ limit: 1_000 });
      expect(
        new Set(tasks.filter((call) => call.purpose === 'task').map((call) => call.task)),
      ).toEqual(new Set(['redact-names', 'extract-signal']));

      service.child.kill('SIGTERM');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      const output = JSON.stringify(service.logs) + service.stderr();
      for (const secret of [...Object.values(keys), test.url, 'Sarah Chen', 'author_y']) {
        expect(output).not.toContain(secret);
      }
    } finally {
      service.kill();
      await Promise.all([hn.close(), ...fakes.map((fake) => fake.close())]);
      await test.drop();
    }
  });
});
