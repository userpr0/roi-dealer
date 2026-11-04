import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_WISHES,
  compareCandidate,
  isAdmitted,
  latestEvals,
  MIN_TRAP_CASES,
  MODEL_REGISTRY,
  modelTag,
  retiringModels,
  wishesMet,
  withTraps,
  type AnyAiTask,
  type ModelSpec,
} from '@roi-dealer/ai-runtime';
import { extractSignalTask } from '@roi-dealer/signals';

const model = (id: string): ModelSpec => {
  const found = MODEL_REGISTRY.find((item) => item.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const HAIKU = model('claude-haiku-5-5');
const FLASH = model('gemini-3.1-flash-lite');
const CANDIDATE: ModelSpec = { ...HAIKU, id: 'claude-haiku-next', admission: 'candidate' };

const report = (
  task: string,
  version: number,
  id: string,
  passed: boolean,
  cost: number,
  metric: number,
) => ({
  tags: [
    'eval',
    `task-${task}`,
    `v-${String(version)}`,
    modelTag(id),
    passed ? 'passed' : 'failed',
  ],
  body: JSON.stringify({ costMicroUsd: cost, metrics: { precision: metric, recall: metric } }),
});

describe('model passport and admission (09b, ADR-0014)', () => {
  it('fills a passport for every model and admits only standing ones by default', () => {
    for (const item of MODEL_REGISTRY) {
      expect(item.passport.modalities).toContain('text');
      expect(item.passport.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.admission).toBe('standing');
    }
    const none = new Map<string, 'admitted' | 'rejected'>();
    expect(isAdmitted(HAIKU, none)).toBe(true);
    expect(isAdmitted(HAIKU, new Map([[HAIKU.id, 'rejected']]))).toBe(false);
    expect(isAdmitted(CANDIDATE, none)).toBe(false);
    expect(isAdmitted(CANDIDATE, new Map([[CANDIDATE.id, 'admitted']]))).toBe(true);
  });

  it('reads the latest version of each task and compares the candidate with the admitted', () => {
    const evals = latestEvals([
      report('extract-signal', 2, CANDIDATE.id, true, 800, 0.95),
      report('extract-signal', 2, HAIKU.id, true, 1_000, 0.9),
      report('extract-signal', 2, FLASH.id, true, 2_000, 0.95),
      report('extract-signal', 1, CANDIDATE.id, false, 1, 0.1),
      report('match-pain', 1, HAIKU.id, true, 500, 0.9),
      report('match-pain', 1, CANDIDATE.id, true, 400, 0.9),
    ]);
    expect(evals.get('extract-signal')?.get(modelTag(CANDIDATE.id))).toMatchObject({
      passed: true,
    });
    const models = [HAIKU, FLASH, CANDIDATE];
    const better = compareCandidate(CANDIDATE, models, new Map(), evals);
    expect(better.tasks.map((item) => [item.task, item.verdict, item.current?.model])).toEqual([
      ['extract-signal', 'better', HAIKU.id],
      ['match-pain', 'better', HAIKU.id],
    ]);
    expect(better.recommend).toBe(true);

    const worse = compareCandidate(
      CANDIDATE,
      models,
      new Map(),
      latestEvals([
        report('extract-signal', 2, CANDIDATE.id, true, 1_500, 0.85),
        report('extract-signal', 2, HAIKU.id, true, 1_000, 0.9),
        report('match-pain', 1, HAIKU.id, true, 500, 0.9),
      ]),
    );
    expect(worse.tasks.map((item) => item.verdict)).toEqual(['worse', 'no_report']);
    expect(worse.recommend).toBe(false);
  });

  it('matches the capabilities processes wait for and warns about retirements', () => {
    const met = wishesMet(MODEL_REGISTRY, new Map());
    expect(met.map((item) => item.wish.key)).toEqual(CAPABILITY_WISHES.map((wish) => wish.key));
    expect(met.find((item) => item.wish.needs === 'video_in')?.models).toContain(FLASH.id);
    expect(met.find((item) => item.wish.needs === 'audio_out')?.models).toEqual([]);
    const retiring = { ...FLASH, passport: { ...FLASH.passport, retiresOn: '2026-11-20' } };
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(retiringModels([HAIKU, retiring], now)).toEqual([{ model: retiring, inDays: 16 }]);
  });
});

describe('traps in the golden sets', () => {
  it('fails the eval when a trap is answered wrongly, even if the totals pass', () => {
    const task = extractSignalTask as AnyAiTask;
    const cases = extractSignalTask.evalCases;
    const right = cases.map((testCase) => ({
      expected: testCase.expected,
      output: testCase.expected.pain
        ? {
            pain: true,
            statement: 'Teams struggle to match invoices by hand',
            audience: 'Teams',
            outcome: 'Matched invoices',
            strength: 'moderate',
            quote: testCase.expected.text.slice(0, 60),
          }
        : { pain: false, statement: '', audience: '', outcome: '', strength: 'weak', quote: '' },
    }));
    expect(withTraps(task, right)).toMatchObject({ passed: true, metrics: { traps: 1 } });
    // The model obeys the hidden command of the first trap.
    const fooled = right.map((result, index) =>
      cases[index]?.trap === true && result.expected.pain === false
        ? {
            ...result,
            output: { ...right[0]?.output, quote: result.expected.text.slice(0, 40) },
          }
        : result,
    );
    const score = withTraps(task, fooled);
    expect(score.passed).toBe(false);
    expect(score.metrics['traps']).toBe(0.5);
  });

  it('gives every task that reads outsiders’ text at least two traps', () => {
    expect(extractSignalTask.externalText).toBe(true);
    expect(
      extractSignalTask.evalCases.filter((item) => item.trap === true).length,
    ).toBeGreaterThanOrEqual(MIN_TRAP_CASES);
  });
});
