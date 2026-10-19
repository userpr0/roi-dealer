import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_RUNTIME_ACTOR,
  AI_TASKS,
  callCostMicroUsd,
  createAiRuntime,
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAiProvider,
  MODEL_REGISTRY,
  recordDailyAiCost,
  redactNames,
  redactNamesTask,
  type AiRuntime,
  type ModelSpec,
} from '@roi-dealer/ai-runtime';
import { ensureAccessRequest } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  resumeSystem,
  startOfUtcDay,
  toTimestamp,
  type Actor,
  type AiBudgetLimits,
  type SystemControl,
} from '@roi-dealer/domain';
import {
  collectEvidence,
  connectableEntry,
  ensureConnection,
  EVIDENCE_ENGINE_ACTOR,
  integrationActor,
  SOURCE_CATALOG,
  type CatalogEntry,
  type CollectedItem,
  type SourceConnector,
} from '@roi-dealer/evidence';
import { OWNER } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { promptText, startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';

const USD = 1_000_000;
const KEYS = {
  anthropic: 'sk-ant-test-0123456789',
  openai: 'sk-openai-test-0123456789',
  google: 'gemini-test-key-0123456789',
};
const CONTEXT = { actor: EVIDENCE_ENGINE_ACTOR, correlationId: 'test-run' } as const;
const GOLDEN = new Map(redactNamesTask.evalCases.map((c) => [c.input.text, c.expected]));
const SARAH = 'My cofounder Sarah Chen and I built a CRM for dentists.';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let gemini: FakeAi;
let gpt: FakeAi;
const { logger, records } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());

const bulk = (id: string): ModelSpec => {
  const model = MODEL_REGISTRY.find((item) => item.id === id);
  if (model === undefined) throw new Error(`no model ${id}`);
  return model;
};
const HAIKU = bulk('claude-haiku-5-5');
const FLASH_LITE = bulk('gemini-3.1-flash-lite');
const GPT_MINI = bulk('gpt-5.4-mini');

/** Answers like a perfect model: the golden names, or none for other texts. */
const oracle = (request: FakeAiRequest) => ({
  text: JSON.stringify({ names: GOLDEN.get(promptText(request.prompt)) ?? [] }),
});

function runtime(
  extra: {
    limits?: AiBudgetLimits;
    models?: readonly ModelSpec[];
    timeoutMs?: number;
    now?: () => number;
  } = {},
): AiRuntime {
  return createAiRuntime({
    database: db,
    logger,
    providers: [
      createAnthropicProvider({ apiKey: KEYS.anthropic, baseUrl: claude.baseUrl }),
      createGoogleProvider({ apiKey: KEYS.google, baseUrl: gemini.baseUrl }),
      createOpenAiProvider({ apiKey: KEYS.openai, baseUrl: gpt.baseUrl }),
    ],
    timeoutMs: 5_000,
    ...extra,
  });
}

async function latestCalls(count: number) {
  return (await db.aiCalls.list({ limit: count })).reverse();
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

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  gemini = await startFakeAi('google');
  gpt = await startFakeAi('openai');
});

afterAll(async () => {
  await claude.close();
  await gemini.close();
  await gpt.close();
  await test.drop();
});

beforeEach(() => {
  claude.listModels(['claude-haiku-5-5', 'claude-opus-5-5']);
  gemini.listModels(['gemini-3.1-flash-lite', 'gemini-3.1-pro-preview']);
  gpt.listModels(['gpt-5.4-mini']);
  for (const fake of [claude, gemini, gpt]) fake.answer(oracle);
});

describe('no call without keys, valid input and a passing eval', () => {
  it('without providers every task is unavailable', async () => {
    const offline = createAiRuntime({ database: db, logger, providers: [] });
    await expect(offline.runTask(redactNamesTask, { text: SARAH }, CONTEXT)).rejects.toMatchObject({
      code: 'unavailable',
      task: 'redact-names',
    });
    expect(await offline.evaluateMissing(AI_TASKS)).toEqual([]);
  });

  it('refuses input outside the task schema', async () => {
    await expect(runtime().runTask(redactNamesTask, { text: '' }, CONTEXT)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      runtime().runTask(redactNamesTask, { text: 'x'.repeat(5_001) }, CONTEXT),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('a model without an eval report is never called', async () => {
    await expect(
      runtime().runTask(redactNamesTask, { text: SARAH }, CONTEXT),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect([...claude.calls, ...gemini.calls, ...gpt.calls]).toEqual([]);
  });
});

describe('evals (D-014 п.7)', () => {
  it('confirms the models with the providers', async () => {
    await expect(runtime().verifyModels()).resolves.toEqual({
      'claude-haiku-5-5': true,
      'claude-opus-5-5': true,
      'gemini-3.1-flash-lite': true,
      'gpt-5.4-mini': true,
    });
    expect(claude.requests).toContain('/v1/models');
    expect(gemini.requests).toContain('/v1beta/models');
    expect(gpt.requests).toContain('/v1/models');
  });

  it('evaluates every usable model once and stores the report as knowledge', async () => {
    const reports = await runtime().evaluateMissing(AI_TASKS);
    expect(reports.map((report) => [report.model, report.score.passed, report.cases])).toEqual([
      ['claude-haiku-5-5', true, 24],
      ['gemini-3.1-flash-lite', true, 24],
      ['gpt-5.4-mini', true, 24],
    ]);
    // The bulk task runs on bulk models only; the golden texts went to every provider.
    expect(claude.calls).toHaveLength(24);
    expect(gemini.calls).toHaveLength(24);
    expect(gpt.calls).toHaveLength(24);
    expect(gemini.calls[0]?.instructions).toBe(redactNamesTask.instructions);
    expect(new Set(claude.calls.map((call) => call.model))).toEqual(new Set(['claude-haiku-5-5']));
    expect(claude.calls[0]?.instructions).toBe(redactNamesTask.instructions);
    expect(promptText(gpt.calls[0]?.prompt ?? '')).toBe(redactNamesTask.evalCases[0]?.input.text);
    expect(claude.keys).toEqual(new Set([KEYS.anthropic]));
    expect(gemini.keys).toEqual(new Set([KEYS.google]));
    expect(gpt.keys).toEqual(new Set([KEYS.openai]));

    const [asset] = await db.repositories.knowledgeAssets.listByTags([
      'eval',
      'task-redact-names',
      'v-1',
      'model-claude-haiku-5-5',
    ]);
    expect(asset).toMatchObject({
      kind: 'knowledge',
      title: 'Eval redact-names v1 · claude-haiku-5-5: пройден',
      createdBy: AI_RUNTIME_ACTOR,
    });
    expect(asset?.tags).toContain('passed');
    expect(JSON.parse(asset?.body ?? '{}')).toMatchObject({
      task: 'redact-names',
      version: 1,
      model: 'claude-haiku-5-5',
      cases: 24,
      passed: true,
      metrics: { precision: 1, recall: 1, answered: 1 },
      costMicroUsd: 24 * callCostMicroUsd(HAIKU, 120, 30),
    });

    const evalCalls = await db.aiCalls.list({ limit: 100 });
    expect(evalCalls).toHaveLength(72);
    expect(evalCalls.every((call) => call.purpose === 'eval' && call.outcome === 'ok')).toBe(true);
    expect(evalCalls[0]).toMatchObject({
      actorType: 'system',
      actorId: 'ai-runtime',
      correlationId: 'ai-eval-redact-names-v1',
    });

    // A report exists for this version: nothing to evaluate again.
    expect(await runtime().evaluateMissing(AI_TASKS)).toEqual([]);
    expect(claude.calls).toHaveLength(24);
  });

  it('a new task version needs its own eval', async () => {
    const next = { ...redactNamesTask, version: 2 };
    const ai = runtime();
    await expect(ai.runTask(next, { text: SARAH }, CONTEXT)).rejects.toMatchObject({
      code: 'unavailable',
    });
    const calls = claude.calls.length;
    await expect(ai.evaluate(next, 'claude-haiku-5-5')).resolves.toMatchObject({
      version: 2,
      score: { passed: true },
    });
    expect(claude.calls).toHaveLength(calls + 24);
    await expect(ai.runTask(next, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
  });

  it('a model added without a report is not used; a failed report keeps it out', async () => {
    const candidate: ModelSpec = { ...HAIKU, id: 'claude-haiku-next' };
    const ai = runtime({ models: [candidate, GPT_MINI] });
    await expect(ai.runTask(redactNamesTask, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
    expect(claude.calls.filter((call) => call.model === 'claude-haiku-next')).toEqual([]);

    // The candidate takes products for people: its eval fails.
    claude.answer(() => ({ text: JSON.stringify({ names: ['Notion', 'Stripe'] }) }));
    const report = await ai.evaluate(redactNamesTask, 'claude-haiku-next');
    expect(report.score.passed).toBe(false);
    const [asset] = await db.repositories.knowledgeAssets.listByTags([
      'eval',
      'model-claude-haiku-next',
    ]);
    expect(asset?.tags).toContain('failed');
    expect(asset?.title).toBe('Eval redact-names v1 · claude-haiku-next: не пройден');

    const calls = claude.calls.length;
    await ai.runTask(redactNamesTask, { text: SARAH }, CONTEXT);
    expect(claude.calls).toHaveLength(calls);
  });
});

describe('routing (ADR-0006, D-021)', () => {
  it('orders the models by their evals: the cheapest that passed goes first', async () => {
    // Same answers and tokens everywhere: the order follows the prices (Claude, Gemini, GPT).
    await expect(runtime().route(redactNamesTask)).resolves.toEqual([
      'claude-haiku-5-5',
      'gemini-3.1-flash-lite',
      'gpt-5.4-mini',
    ]);
    // A version on which Claude needs many more tokens: Gemini is cheaper and goes first.
    const verbose = { ...redactNamesTask, version: 3 };
    const ai = runtime();
    claude.answer((request) => ({ ...oracle(request), outputTokens: 1_000 }));
    await ai.evaluate(verbose, 'claude-haiku-5-5');
    await ai.evaluate(verbose, 'gemini-3.1-flash-lite');
    await expect(ai.route(verbose)).resolves.toEqual(['gemini-3.1-flash-lite', 'claude-haiku-5-5']);
    const calls = gemini.calls.length;
    await expect(ai.runTask(verbose, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
    expect(gemini.calls).toHaveLength(calls + 1);
  });

  it('the primary model answers and the call is journaled with its cost', async () => {
    const calls = { claude: claude.calls.length, gemini: gemini.calls.length };
    await expect(runtime().runTask(redactNamesTask, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
    expect(claude.calls).toHaveLength(calls.claude + 1);
    expect(gemini.calls).toHaveLength(calls.gemini);
    const [call] = await latestCalls(1);
    expect(call).toMatchObject({
      task: 'redact-names',
      taskVersion: 1,
      purpose: 'task',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      inputTokens: 120,
      outputTokens: 30,
      costMicroUsd: callCostMicroUsd(HAIKU, 120, 30),
      outcome: 'ok',
      actorType: 'system',
      actorId: 'evidence-engine',
      correlationId: 'test-run',
    });
    expect(call).not.toHaveProperty('failure');
  });

  it.each([
    [
      'an answer that is not JSON',
      { text: 'Sure! Here are the names: Sarah', outputTokens: 50 },
      'invalid_output',
    ],
    [
      'an answer outside the schema',
      { text: '{"names":"Sarah Chen"}', outputTokens: 50 },
      'invalid_output',
    ],
    [
      'a cut-off answer',
      { text: '{"names":[', stop: 'max_tokens' as const, outputTokens: 50 },
      'invalid_output',
    ],
    ['a refusal', { text: '', stop: 'refusal' as const, outputTokens: 50 }, 'refusal'],
    ['a rate limit', { status: 429 }, 'rate_limited'],
    ['an overloaded API', { status: 529 }, 'server_error'],
    ['a missing model', { status: 404 }, 'model_unavailable'],
    ['a rejected key', { status: 401 }, 'auth'],
  ])('%s is classified alike by every adapter and falls back', async (_case, answer, failure) => {
    for (const [fake, model] of [
      [claude, HAIKU],
      [gemini, FLASH_LITE],
      [gpt, GPT_MINI],
    ] as const) {
      fake.answer(() => answer);
      await expect(
        runtime({ models: [model] }).runTask(redactNamesTask, { text: SARAH }, CONTEXT),
      ).rejects.toMatchObject({ code: 'failed', attempts: [{ model: model.id, failure }] });
      fake.answer(oracle);
    }
    claude.answer(() => answer);
    await expect(runtime().runTask(redactNamesTask, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
    const [failed, served] = await latestCalls(2);
    expect(failed).toMatchObject({ provider: 'anthropic', outcome: 'failed', failure });
    expect(served).toMatchObject({
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
      outcome: 'ok',
    });
    // A model that answered is paid for, even when its answer is unusable.
    if ('outputTokens' in answer) {
      expect(failed?.costMicroUsd).toBe(callCostMicroUsd(HAIKU, 120, 50));
    }
  });

  it('a slow answer is a timeout, then the fallback answers', async () => {
    claude.answer((request) => ({ ...oracle(request), delayMs: 1_000 }));
    gemini.answer((request) => ({ ...oracle(request), delayMs: 1_000 }));
    await expect(
      runtime({ timeoutMs: 200 }).runTask(redactNamesTask, { text: SARAH }, CONTEXT),
    ).resolves.toEqual({ names: ['Sarah Chen'] });
    const [claudeCall, geminiCall, served] = await latestCalls(3);
    expect(claudeCall).toMatchObject({
      provider: 'anthropic',
      failure: 'timeout',
      costMicroUsd: 0,
    });
    expect(geminiCall).toMatchObject({ provider: 'google', failure: 'timeout', costMicroUsd: 0 });
    expect(served).toMatchObject({ provider: 'openai', outcome: 'ok' });
  });

  it('when every model fails, the error lists the attempts', async () => {
    claude.answer(() => ({ status: 500 }));
    gemini.answer(() => ({ text: '', stop: 'refusal' }));
    gpt.answer(() => ({ text: 'no json here' }));
    await expect(
      runtime().runTask(redactNamesTask, { text: SARAH }, CONTEXT),
    ).rejects.toMatchObject({
      code: 'failed',
      attempts: [
        { model: 'claude-haiku-5-5', outcome: 'failed', failure: 'server_error' },
        { model: 'gemini-3.1-flash-lite', outcome: 'failed', failure: 'refusal' },
        { model: 'gpt-5.4-mini', outcome: 'failed', failure: 'invalid_output' },
      ],
    });
  });

  it('a model the provider does not list is not used', async () => {
    claude.listModels(['claude-opus-5-5']);
    const ai = runtime();
    await expect(ai.verifyModels()).resolves.toMatchObject({ 'claude-haiku-5-5': false });
    const calls = claude.calls.length;
    await expect(ai.runTask(redactNamesTask, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
    expect(claude.calls).toHaveLength(calls);
    const [served] = await latestCalls(1);
    expect(served).toMatchObject({ provider: 'google', outcome: 'ok' });
  });
});

describe('limits and the kill switch (D-007, §2.6)', () => {
  it('the kill switch stops tasks and evals before any call', async () => {
    await setKillSwitch(true);
    const calls = claude.calls.length + gemini.calls.length + gpt.calls.length;
    try {
      const ai = runtime();
      await expect(ai.runTask(redactNamesTask, { text: SARAH }, CONTEXT)).rejects.toMatchObject({
        code: 'automation_paused',
      });
      await expect(ai.evaluate(redactNamesTask, 'claude-haiku-5-5')).rejects.toMatchObject({
        code: 'automation_paused',
      });
    } finally {
      await setKillSwitch(false);
    }
    expect(claude.calls.length + gemini.calls.length + gpt.calls.length).toBe(calls);
  });

  it('a call that would exceed the daily or the monthly limit is not made', async () => {
    const spent = await runtime().spend();
    expect(spent.day).toBeGreaterThan(0);
    const calls = claude.calls.length + gemini.calls.length + gpt.calls.length;
    for (const limits of [
      { monthlyMicroUsd: 50 * USD, dailyCapMicroUsd: spent.day + 1_000 },
      { monthlyMicroUsd: spent.month + 1_000, dailyCapMicroUsd: 20 * USD },
    ]) {
      await expect(
        runtime({ limits }).runTask(redactNamesTask, { text: SARAH }, CONTEXT),
      ).rejects.toMatchObject({ code: 'budget', attempts: [] });
      await expect(
        runtime({ limits }).evaluate(redactNamesTask, 'claude-haiku-5-5'),
      ).rejects.toMatchObject({ code: 'budget' });
    }
    expect(claude.calls.length + gemini.calls.length + gpt.calls.length).toBe(calls);
  });

  it('a task that used its share of the day stops; another task keeps its own', async () => {
    const other = { ...redactNamesTask, name: 'other-task' };
    await runtime().evaluate(other, 'claude-haiku-5-5');
    const from = toTimestamp(new Date(startOfUtcDay(Date.now())));
    const used = await db.aiCalls.spend({ from, task: 'redact-names', purpose: 'task' });
    const day = await db.aiCalls.spend({ from });
    // Today's allowance where redact-names (10%) has no room for one more call; the day has.
    const allowance = (used.costMicroUsd + redactNamesTask.maxCostMicroUsd) * 10 - 10;
    expect(allowance).toBeGreaterThan(day.costMicroUsd + 2 * redactNamesTask.maxCostMicroUsd);
    const tight = runtime({
      limits: { monthlyMicroUsd: 1_000 * USD, dailyCapMicroUsd: allowance },
    });
    await expect(tight.runTask(redactNamesTask, { text: SARAH }, CONTEXT)).rejects.toMatchObject({
      code: 'budget',
    });
    await expect(tight.runTask(other, { text: SARAH }, CONTEXT)).resolves.toEqual({
      names: ['Sarah Chen'],
    });
  });
});

describe('evidence: AI proposes names, code replaces them (PHASE 05 residual risk)', () => {
  let catalog: CatalogEntry[];
  let entry: CatalogEntry;
  let externalId = 0;

  const connector = (texts: readonly string[]): SourceConnector => ({
    catalogKey: entry.key,
    fetch: () => {
      const items: CollectedItem[] = texts.map((text) => {
        externalId += 1;
        return { externalId: String(externalId), kind: 'post', text, observedAt: now() };
      });
      return Promise.resolve({
        requestUrl: 'https://forum.example/api/latest',
        contentSha256: 'a'.repeat(64),
        itemCount: items.length,
        items,
      });
    },
  });

  beforeAll(async () => {
    entry = { ...connectableEntry('hacker-news'), key: 'ai-forum', name: 'Test ai-forum' };
    catalog = [...SOURCE_CATALOG, entry];
    const deps = { database: db, logger, ensureAccess: ensureAccessRequest, catalog };
    await ensureConnection(entry.key, deps);
    const actor: Actor = integrationActor(entry);
    const principal = await db.repositories.principals.getByActor(actor);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
  });

  async function excerpts(snapshotId: string): Promise<string[]> {
    const rows = await db.sql<{ excerpt: string }[]>`
      select excerpt from evidence where snapshot_id = ${snapshotId} order by external_id::int
    `;
    return rows.map((row) => row.excerpt);
  }

  it('replaces the names the model found and ignores invented ones', async () => {
    claude.answer(() => ({ text: JSON.stringify({ names: ['Sarah Chen', 'Invented Person'] }) }));
    const ai = runtime();
    const outcome = await collectEvidence(
      connector(['Sarah Chen and I pay $300 a month for invoicing. Mail sarah@example.com']),
      {
        database: db,
        logger,
        catalog,
        redactNames: (text) => redactNames(ai, text, { actor: EVIDENCE_ENGINE_ACTOR }),
      },
    );
    expect(outcome).toMatchObject({ status: 'collected', evidenceCount: 1, redactions: 2 });
    if (outcome.status !== 'collected') throw new Error('not collected');
    expect(await excerpts(outcome.snapshotId)).toEqual([
      '[name] and I pay $300 a month for invoicing. Mail [email]',
    ]);
    // The model saw the text already cleaned by the rules.
    expect(promptText(claude.calls.at(-1)?.prompt ?? '')).not.toContain('sarah@example.com');
  });

  it('without AI the load keeps the rule-based text and tries the providers once', async () => {
    for (const fake of [claude, gemini, gpt]) fake.answer(() => ({ status: 503 }));
    const calls = [claude, gemini, gpt].map((fake) => fake.calls.length);
    const ai = runtime();
    const outcome = await collectEvidence(
      connector(['Tom Becker hates spreadsheets.', 'Call (555) 123-4567 about invoices.']),
      {
        database: db,
        logger,
        catalog,
        redactNames: (text) => redactNames(ai, text, { actor: EVIDENCE_ENGINE_ACTOR }),
      },
    );
    expect(outcome).toMatchObject({ status: 'collected', evidenceCount: 2 });
    if (outcome.status !== 'collected') throw new Error('not collected');
    expect(await excerpts(outcome.snapshotId)).toEqual([
      'Tom Becker hates spreadsheets.',
      'Call [phone] about invoices.',
    ]);
    expect([claude, gemini, gpt].map((fake) => fake.calls.length)).toEqual(
      calls.map((count) => count + 1),
    );
    expect(
      records.filter((record) => record['message'] === 'name redaction unavailable: rules only'),
    ).toEqual([expect.objectContaining({ catalog_key: 'ai-forum', code: 'failed' })]);
  });
});

describe('the daily cost entry (§2.8)', () => {
  it('records a day of AI spend once, rounded up to a cent', async () => {
    const nowMs = Date.now();
    const date = new Date(nowMs).toISOString().slice(0, 10);
    const day = await db.aiCalls.spend({
      from: toTimestamp(new Date(`${date}T00:00:00.000Z`)),
    });
    expect(day.costMicroUsd).toBeGreaterThan(0);

    await expect(recordDailyAiCost(db, date, nowMs)).resolves.toBe('recorded');
    await expect(recordDailyAiCost(db, date, nowMs)).resolves.toBe('already_recorded');
    await expect(recordDailyAiCost(db, '2001-01-01', nowMs)).resolves.toBe('nothing_spent');

    const rows = await db.sql<
      { amount_usd_cents: string; description: string; created_by_id: string }[]
    >`select amount_usd_cents, description, created_by_id from cost_entries where category = 'ai'`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount_usd_cents)).toBe(Math.ceil(day.costMicroUsd / 10_000));
    expect(rows[0]?.description).toContain(`AI за ${date} (UTC): вызовов ${String(day.calls)}`);
    expect(rows[0]?.created_by_id).toBe('ai-runtime');
  });
});

describe('the journal never holds secrets or texts', () => {
  it('keeps keys and prompts out of the logs and the database', async () => {
    const logs = JSON.stringify(records);
    const stored = JSON.stringify(await db.sql`select * from ai_calls`);
    for (const secret of [...Object.values(KEYS), 'Sarah Chen', 'Tom Becker']) {
      expect(logs).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  it('ai_calls is append-only (migration 0006)', async () => {
    await expect(db.sql`update ai_calls set cost_micro_usd = 0`).rejects.toThrow();
    await expect(db.sql`delete from ai_calls`).rejects.toThrow();
  });
});

describe('pacing over the month (D-021)', () => {
  it('a month spent early leaves the later days only what is left', async () => {
    // Another month, far from the calls above: $45 spent on the 5th, today is the 20th.
    const today = Date.parse('2031-03-20T12:00:00.000Z');
    await db.aiCalls.record({
      occurredAt: toTimestamp(new Date('2031-03-05T09:00:00.000Z')),
      task: 'redact-names',
      taskVersion: 1,
      purpose: 'task',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 45 * USD,
      latencyMs: 1,
      outcome: 'ok',
      actorType: 'system',
      actorId: 'evidence-engine',
    });
    // $5 left over 12 days (20–31 March).
    await expect(runtime({ now: () => today }).spend()).resolves.toEqual({
      month: 45 * USD,
      day: 0,
      allowance: Math.floor((5 * USD) / 12),
    });
  });
});
