import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AI_TASKS,
  applyNameRedaction,
  callCostMicroUsd,
  classifyError,
  EVAL_DAILY_SHARE,
  MIN_EVAL_CASES,
  MODEL_REGISTRY,
  modelTag,
  parseOutput,
  previousUtcDate,
  ProviderFailure,
  redactNamesTask,
  routingOrder,
  scoreRedactNames,
  TASK_TIERS,
  type ModelSpec,
} from '@roi-dealer/ai-runtime';
import { AI_BUDGET_LIMITS, dailyAiAllowanceMicroUsd, daysLeftInUtcMonth } from '@roi-dealer/domain';

const USD = 1_000_000;

class ApiError extends Error {
  constructor(readonly status: number) {
    super(`status ${String(status)}`);
  }
}

describe('model registry (D-012, ADR-0006)', () => {
  it('has unique ids, prices and structured output for every model', () => {
    expect(new Set(MODEL_REGISTRY.map((model) => model.id)).size).toBe(MODEL_REGISTRY.length);
    for (const model of MODEL_REGISTRY) {
      expect(TASK_TIERS).toContain(model.tier);
      expect(model.inputMicroUsdPerMTok).toBeGreaterThan(0);
      expect(model.outputMicroUsdPerMTok).toBeGreaterThan(0);
      expect(model.structuredOutput).toBe(true);
      expect(model.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('offers all three providers for bulk work (D-021)', () => {
    const bulk = MODEL_REGISTRY.filter((model) => model.tier === 'bulk');
    expect(new Set(bulk.map((model) => model.provider))).toEqual(
      new Set(['anthropic', 'google', 'openai']),
    );
  });

  it('prices a call in micro-USD, rounded up', () => {
    const model = { inputMicroUsdPerMTok: 0.1 * USD, outputMicroUsdPerMTok: 0.5 * USD };
    expect(callCostMicroUsd(model, 1_000_000, 0)).toBe(100_000);
    expect(callCostMicroUsd(model, 0, 2_000_000)).toBe(1_000_000);
    expect(callCostMicroUsd(model, 1, 1)).toBe(1);
    expect(callCostMicroUsd(model, 0, 0)).toBe(0);
  });

  it('turns model ids into knowledge tags', () => {
    expect(modelTag('gpt-5.4-mini')).toBe('model-gpt-5-4-mini');
    expect(modelTag('claude-haiku-5-5')).toBe('model-claude-haiku-5-5');
  });
});

describe('the AI budget lasts the whole month (D-007, D-021)', () => {
  const at = (iso: string) => Date.parse(iso);

  it('keeps the limits of D-007: $50 a month, never more than $20 a day', () => {
    expect(AI_BUDGET_LIMITS).toEqual({ monthlyMicroUsd: 50 * USD, dailyCapMicroUsd: 20 * USD });
  });

  it('counts the days left in the UTC month, today included', () => {
    expect(daysLeftInUtcMonth(at('2026-10-01T00:00:00Z'))).toBe(31);
    expect(daysLeftInUtcMonth(at('2026-10-18T23:59:00Z'))).toBe(14);
    expect(daysLeftInUtcMonth(at('2026-10-31T12:00:00Z'))).toBe(1);
    expect(daysLeftInUtcMonth(at('2026-02-01T00:00:00Z'))).toBe(28);
  });

  it('spreads what is left of the month over the days left', () => {
    // A fresh 30-day month: $50 / 30.
    expect(dailyAiAllowanceMicroUsd(AI_BUDGET_LIMITS, 0, at('2026-11-01T08:00:00Z'))).toBe(
      1_666_666,
    );
    // Quiet days leave more for the rest: $45 left on the last 10 days.
    expect(dailyAiAllowanceMicroUsd(AI_BUDGET_LIMITS, 5 * USD, at('2026-11-21T08:00:00Z'))).toBe(
      4_500_000,
    );
    // The last day may use what is left, up to the daily cap.
    expect(dailyAiAllowanceMicroUsd(AI_BUDGET_LIMITS, 0, at('2026-11-30T08:00:00Z'))).toBe(
      20 * USD,
    );
    // The month is spent: nothing today.
    expect(dailyAiAllowanceMicroUsd(AI_BUDGET_LIMITS, 51 * USD, at('2026-11-21T08:00:00Z'))).toBe(
      0,
    );
  });

  it('gives every process its share of the day: the shares add up to at most 1', () => {
    const shares = [...AI_TASKS.map((task) => task.dailyShare), EVAL_DAILY_SHARE];
    for (const share of shares) {
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThanOrEqual(1);
    }
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(1);
  });
});

describe('routing by evals (D-021)', () => {
  const model = (id: string, provider: ModelSpec['provider']): ModelSpec => ({
    ...(MODEL_REGISTRY[0] as ModelSpec),
    id,
    provider,
  });
  const claude = model('claude', 'anthropic');
  const claude2 = model('claude-2', 'anthropic');
  const gemini = model('gemini', 'google');
  const gpt = model('gpt', 'openai');
  const report = (costMicroUsd: number, quality: number) => ({
    passed: true,
    costMicroUsd,
    quality,
  });

  it('bulk work goes to the cheapest model that passed, then to another provider', () => {
    expect(
      routingOrder('bulk', [
        { model: claude, report: report(500, 0.95) },
        { model: claude2, report: report(600, 0.99) },
        { model: gemini, report: report(300, 0.9) },
        { model: gpt, report: report(900, 1) },
      ]).map((item) => item.id),
    ).toEqual(['gemini', 'claude', 'claude-2', 'gpt']);
  });

  it('judgement goes to the best model, then to another provider', () => {
    expect(
      routingOrder('strong', [
        { model: claude, report: report(5_000, 0.97) },
        { model: claude2, report: report(9_000, 0.96) },
        { model: gpt, report: report(4_000, 0.9) },
      ]).map((item) => item.id),
    ).toEqual(['claude', 'gpt', 'claude-2']);
  });

  it('keeps the registry order on ties and returns nothing without passing models', () => {
    expect(
      routingOrder('bulk', [
        { model: claude, report: report(100, 1) },
        { model: gpt, report: report(100, 1) },
      ]).map((item) => item.id),
    ).toEqual(['claude', 'gpt']);
    expect(routingOrder('bulk', [])).toEqual([]);
  });
});

describe('every AI task (D-014 п.7)', () => {
  it.each(AI_TASKS.map((task) => [task.name, task] as const))(
    '%s has a golden set of at least 20 valid cases; no answers never pass',
    (_name, task) => {
      expect(task.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(Number.isInteger(task.version) && task.version >= 1).toBe(true);
      expect(task.evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
      for (const testCase of task.evalCases) {
        expect(task.input.safeParse(testCase.input).success).toBe(true);
      }
      const silent = task.evalCases.map((testCase) => ({
        expected: testCase.expected as unknown,
        output: undefined,
      }));
      expect(task.score(silent).passed).toBe(false);
    },
  );

  it('redact-names: the expected answers pass its own score, deterministically', () => {
    const perfect = redactNamesTask.evalCases.map((testCase) => ({
      expected: testCase.expected,
      output: { names: [...testCase.expected] },
    }));
    expect(redactNamesTask.score(perfect)).toEqual(redactNamesTask.score(perfect));
    expect(redactNamesTask.score(perfect)).toEqual({
      passed: true,
      metrics: { precision: 1, recall: 1, answered: 1 },
    });
    // Both kinds of cases are covered: texts with people and texts with products only.
    expect(redactNamesTask.evalCases.filter((c) => c.expected.length === 0).length).toBeGreaterThan(
      5,
    );
    expect(redactNamesTask.evalCases.filter((c) => c.expected.length > 0).length).toBeGreaterThan(
      5,
    );
  });

  it('have unique names', () => {
    expect(new Set(AI_TASKS.map((task) => task.name)).size).toBe(AI_TASKS.length);
  });

  it('reserve at least the worst-case cost of one call on every model of their tier', () => {
    // redact-names: up to 5 000 characters of text plus the instructions, at most one token each.
    const inputTokens = redactNamesTask.instructions.length + 5_000 + 100;
    for (const model of MODEL_REGISTRY.filter((item) => item.tier === redactNamesTask.tier)) {
      expect(
        callCostMicroUsd(model, inputTokens, redactNamesTask.maxOutputTokens),
      ).toBeLessThanOrEqual(redactNamesTask.maxCostMicroUsd);
    }
  });
});

describe('redact-names scoring', () => {
  const sample = [
    { expected: ['Sarah Chen'], output: { names: ['Sarah Chen'] } },
    { expected: [], output: { names: [] } },
    { expected: ['John'], output: { names: ['John'] } },
  ];

  it('passes exact answers and tolerates a name inside a longer one', () => {
    expect(scoreRedactNames(sample).passed).toBe(true);
    expect(
      scoreRedactNames([{ expected: ['Priya Patel'], output: { names: ['Ms. Priya Patel'] } }])
        .metrics,
    ).toMatchObject({ precision: 1, recall: 1 });
  });

  it('fails when products are taken for people (precision)', () => {
    const score = scoreRedactNames([
      ...sample,
      { expected: [], output: { names: ['Notion', 'Stripe', 'Linear'] } },
    ]);
    expect(score.metrics['precision']).toBeLessThan(0.8);
    expect(score.passed).toBe(false);
  });

  it('fails when names are missed (recall)', () => {
    const score = scoreRedactNames([
      { expected: ['Jordan', 'Casey'], output: { names: ['Jordan'] } },
      { expected: ['Ben', 'Lisa Wong'], output: { names: [] } },
    ]);
    expect(score.metrics['recall']).toBe(0.25);
    expect(score.passed).toBe(false);
  });

  it('fails when too many answers are missing', () => {
    const score = scoreRedactNames([
      { expected: [], output: undefined },
      { expected: [], output: { names: [] } },
    ]);
    expect(score.metrics['answered']).toBe(0.5);
    expect(score.passed).toBe(false);
  });
});

describe('applyNameRedaction: code replaces, AI only proposes (§2.3)', () => {
  it('replaces every occurrence of the proposed names', () => {
    expect(
      applyNameRedaction('Sarah Chen and I met Sarah Chen twice. John agreed.', [
        'Sarah Chen',
        'John',
      ]),
    ).toEqual({ text: '[name] and I met [name] twice. [name] agreed.', replaced: 3 });
  });

  it('ignores names that are not in the text, too short or too long', () => {
    expect(applyNameRedaction('Ask HN: pricing advice', ['Elon', 'A', 'x'.repeat(81)])).toEqual({
      text: 'Ask HN: pricing advice',
      replaced: 0,
    });
  });

  it('replaces longer names first and keeps word boundaries', () => {
    expect(applyNameRedaction('Ann Lee told Annabel and Ann.', ['Ann', 'Ann Lee'])).toEqual({
      text: '[name] told Annabel and [name].',
      replaced: 2,
    });
  });

  it('treats regular expression characters in a name literally', () => {
    expect(applyNameRedaction("Kevin O'Brien (CEO) and Jo.", ["Kevin O'Brien", 'J.'])).toEqual({
      text: '[name] (CEO) and Jo.',
      replaced: 1,
    });
  });
});

describe('provider failures', () => {
  it('classifies SDK errors by status, not by message', () => {
    expect(classifyError(new ApiError(429))).toBe('rate_limited');
    expect(classifyError(new ApiError(401))).toBe('auth');
    expect(classifyError(new ApiError(403))).toBe('auth');
    expect(classifyError(new ApiError(404))).toBe('model_unavailable');
    expect(classifyError(new ApiError(408))).toBe('timeout');
    expect(classifyError(new ApiError(500))).toBe('server_error');
    expect(classifyError(new ApiError(529))).toBe('server_error');
    expect(classifyError(new ApiError(400))).toBe('bad_request');
    const timeout = new Error('timed out');
    timeout.name = 'APIConnectionTimeoutError';
    expect(classifyError(timeout)).toBe('timeout');
    expect(classifyError(new Error('socket hang up'))).toBe('server_error');
    expect(classifyError('not an error')).toBe('server_error');
    expect(classifyError(new ProviderFailure('refusal'))).toBe('refusal');
  });

  it('turns text that is not the schema into invalid_output with the paid tokens', () => {
    const schema = z.strictObject({ names: z.array(z.string()) });
    const usage = { inputTokens: 10, outputTokens: 5 };
    expect(parseOutput(schema, '{"names":["Ann"]}', usage)).toEqual({ names: ['Ann'] });
    for (const text of ['not json', '{"names":"Ann"}', '{"names":[],"extra":1}', '']) {
      try {
        parseOutput(schema, text, usage);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderFailure);
        expect(error).toMatchObject({
          failure: 'invalid_output',
          inputTokens: 10,
          outputTokens: 5,
        });
      }
    }
  });
});

describe('daily cost', () => {
  it('names the UTC day before now', () => {
    expect(previousUtcDate(Date.parse('2026-10-18T00:30:00Z'))).toBe('2026-10-17');
    expect(previousUtcDate(Date.parse('2026-11-01T23:59:00Z'))).toBe('2026-10-31');
  });
});
