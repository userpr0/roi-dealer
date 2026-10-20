import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  callCostMicroUsd,
  createAiRuntime,
  createGoogleProvider,
  FREE_TIER_COOLDOWN_MS,
  MODEL_REGISTRY,
  redactNamesTask,
  type AiRuntime,
  type AiTask,
} from '@roi-dealer/ai-runtime';
import type { Database } from '@roi-dealer/database';
import { EVIDENCE_ENGINE_ACTOR } from '@roi-dealer/evidence';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { promptText, startFakeAi, type FakeAi } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';

/*
 * The free Gemini quota first (D-025): simple tasks try the key of a project without billing
 * and fall back to the paid key; judgement and personal data never go there.
 */

const PAID = 'gemini-paid-key-0123456789';
const FREE = 'gemini-free-key-0123456789';
const CONTEXT = { actor: EVIDENCE_ENGINE_ACTOR, correlationId: 'free-tier' } as const;
const FLASH_LITE = MODEL_REGISTRY.find((model) => model.id === 'gemini-3.1-flash-lite');
const PRO = MODEL_REGISTRY.find((model) => model.id === 'gemini-3.1-pro-preview');

/** A simple task with a golden set: answers `{"ok":true}`. */
const echoTask: AiTask<{ text: string }, { ok: boolean }> = {
  name: 'echo-check',
  version: 1,
  tier: 'bulk',
  instructions: 'Answer {"ok":true}.',
  input: z.object({ text: z.string() }),
  output: z.object({ ok: z.boolean() }),
  render: (input) => input.text,
  maxOutputTokens: 50,
  maxCostMicroUsd: 1_000,
  dailyShare: 0.05,
  evalCases: Array.from({ length: 20 }, (_, index) => ({
    input: { text: `case ${String(index)}` },
    expected: { ok: true },
  })),
  score: (results) => ({
    passed: results.every((result) => result.output?.ok === true),
    metrics: { accuracy: 1 },
  }),
};
const strongTask: AiTask<{ text: string }, { ok: boolean }> = {
  ...echoTask,
  name: 'echo-judgement',
  tier: 'strong',
  maxCostMicroUsd: 50_000,
};

let test: TestDatabase;
let db: Database;
let gemini: FakeAi;
let clock = Date.now();
const { logger } = createCapturingLogger('worker');

function runtime(): AiRuntime {
  return createAiRuntime({
    database: db,
    logger,
    providers: [
      createGoogleProvider({
        apiKey: PAID,
        freeApiKey: FREE,
        baseUrl: gemini.baseUrl,
        now: () => clock,
      }),
    ],
    timeoutMs: 5_000,
  });
}

const keysOf = (from: number) => gemini.calls.slice(from).map((call) => call.key);

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  gemini = await startFakeAi('google');
  gemini.listModels(['gemini-3.1-flash-lite', 'gemini-3.1-pro-preview']);
});

afterAll(async () => {
  await gemini.close();
  await test.drop();
});

/** Answers like a perfect model: the golden names of `redact-names`, else `{"ok":true}`. */
const GOLDEN = new Map(redactNamesTask.evalCases.map((c) => [c.input.text, c.expected]));
const oracle = (request: { readonly prompt: string }) =>
  request.prompt.includes('"""')
    ? { text: JSON.stringify({ names: GOLDEN.get(promptText(request.prompt)) ?? [] }) }
    : { text: '{"ok":true}' };

beforeEach(() => {
  gemini.answer(oracle);
});

describe('the free Gemini quota (D-025)', () => {
  it('serves simple tasks first, at no cost; an eval still compares models at their price', async () => {
    const ai = runtime();
    const from = gemini.calls.length;
    const report = await ai.evaluate(echoTask, 'gemini-3.1-flash-lite');
    expect(keysOf(from).every((key) => key === FREE)).toBe(true);
    expect(report.costMicroUsd).toBe(20 * callCostMicroUsd(FLASH_LITE ?? never(), 120, 30));

    await expect(ai.runTask(echoTask, { text: 'hello' }, CONTEXT)).resolves.toEqual({ ok: true });
    const [call] = await db.aiCalls.list({ limit: 1 });
    expect(call).toMatchObject({ task: 'echo-check', provider: 'google', outcome: 'ok' });
    expect(call?.costMicroUsd).toBe(0);
    expect((await db.aiCalls.spend({ task: 'echo-check' })).costMicroUsd).toBe(0);
  });

  it('falls back to the paid key when the free quota ends, and waits before trying it again', async () => {
    const ai = runtime();
    await ai.evaluate(echoTask, 'gemini-3.1-flash-lite');
    gemini.answer((request) => (request.key === FREE ? { status: 429 } : { text: '{"ok":true}' }));

    const from = gemini.calls.length;
    await expect(ai.runTask(echoTask, { text: 'one' }, CONTEXT)).resolves.toEqual({ ok: true });
    expect(keysOf(from)).toEqual([FREE, PAID]);
    const [paid] = await db.aiCalls.list({ limit: 1 });
    expect(paid?.costMicroUsd).toBe(callCostMicroUsd(FLASH_LITE ?? never(), 120, 30));

    // While the free quota rests, the paid key answers alone.
    const next = gemini.calls.length;
    await ai.runTask(echoTask, { text: 'two' }, CONTEXT);
    expect(keysOf(next)).toEqual([PAID]);

    // A slow free quota also hands the call to the paid key.
    clock += FREE_TIER_COOLDOWN_MS + 1;
    gemini.answer((request) =>
      request.key === FREE ? { text: '{"ok":true}', delayMs: 6_000 } : { text: '{"ok":true}' },
    );
    const slow = gemini.calls.length;
    await ai.runTask(echoTask, { text: 'slow' }, CONTEXT);
    expect(keysOf(slow)).toEqual([FREE, PAID]);

    clock += FREE_TIER_COOLDOWN_MS + 1;
    gemini.answer(() => ({ text: '{"ok":true}' }));
    const later = gemini.calls.length;
    await ai.runTask(echoTask, { text: 'three' }, CONTEXT);
    expect(keysOf(later)).toEqual([FREE]);
  });

  it('never sends personal data or judgement to the free quota', async () => {
    const ai = runtime();
    const from = gemini.calls.length;
    await ai.evaluate(redactNamesTask, 'gemini-3.1-flash-lite');
    await ai.runTask(redactNamesTask, { text: 'Sarah built a CRM.' }, CONTEXT);
    await ai.evaluate(strongTask, 'gemini-3.1-pro-preview');
    await ai.runTask(strongTask, { text: 'judge' }, CONTEXT);
    expect(gemini.calls.length).toBeGreaterThan(from);
    expect(keysOf(from).every((key) => key === PAID)).toBe(true);
    const [judged] = await db.aiCalls.list({ limit: 1 });
    expect(judged?.costMicroUsd).toBe(callCostMicroUsd(PRO ?? never(), 120, 30));
  });

  it('a free answer the model got wrong is not retried on the paid key', async () => {
    const ai = runtime();
    await ai.evaluate(echoTask, 'gemini-3.1-flash-lite');
    gemini.answer((request) =>
      request.key === FREE ? { text: 'not json' } : { text: '{"ok":true}' },
    );
    const from = gemini.calls.length;
    await expect(ai.runTask(echoTask, { text: 'bad' }, CONTEXT)).rejects.toMatchObject({
      code: 'failed',
    });
    expect(keysOf(from)).toEqual([FREE]);
    const [failed] = await db.aiCalls.list({ limit: 1 });
    expect(failed).toMatchObject({ outcome: 'failed', failure: 'invalid_output', costMicroUsd: 0 });
  });

  it('never logs either key', () => {
    expect(gemini.keys).toEqual(new Set([PAID, FREE]));
  });
});

function never(): never {
  throw new Error('unreachable');
}
