import { describe, expect, it } from 'vitest';
import { AGENT_TASKS } from '@roi-dealer/agents';
import {
  AI_TASKS,
  callCostMicroUsd,
  EVAL_DAILY_SHARE,
  MIN_EVAL_CASES,
  MODEL_REGISTRY,
} from '@roi-dealer/ai-runtime';
import { judgesLines } from '@roi-dealer/command-center';
import type { StoredJudgement } from '@roi-dealer/database';
import { JUDGE_CRITERIA, judgePanel, toTimestamp, type JudgeCriterion } from '@roi-dealer/domain';
import {
  CRITERION_SCALES,
  JUDGE_TASKS,
  judgeOpportunityTask,
  scoreJudge,
  toJudgement,
} from '@roi-dealer/judges';
import { MEDIA_TASKS } from '@roi-dealer/media';
import { OPPORTUNITY_TASKS } from '@roi-dealer/opportunities';
import { SIGNAL_TASKS } from '@roi-dealer/signals';
import { perfectJudgeAnswer } from '../../support/judge-answers.js';

const answer = (overrides: Partial<Parameters<typeof toJudgement>[2]> = {}) => ({
  score: 4,
  rationale: 'People pay a bookkeeper $400 a month for this every month.',
  evidence: [2],
  concerns: [],
  ...overrides,
});

describe('a judge’s answer is checked by code (PHASE 11, §2.3, §2.5)', () => {
  it('needs an integer score 1–5 and a real rationale', () => {
    for (const score of [0, 6, 2.5, -1]) {
      expect(toJudgement('market', 3, answer({ score }))).toBe('rejected');
    }
    expect(toJudgement('market', 3, answer({ rationale: 'Looks good.' }))).toBe('rejected');
    expect(toJudgement('market', 3, answer())).toEqual({
      score: 4,
      supported: true,
      rationale: 'People pay a bookkeeper $400 a month for this every month.',
      concerns: [],
      evidence: [1],
    });
  });

  it('keeps only citations of existing excerpts', () => {
    expect(toJudgement('market', 3, answer({ evidence: [3, 0, 9, 3, 1, 1.5] }))).toMatchObject({
      evidence: [0, 2],
      supported: true,
    });
  });

  it('caps market, pain and economics at 2 without evidence, not the other criteria', () => {
    for (const criterion of ['market', 'pain_value', 'economics'] as const) {
      expect(toJudgement(criterion, 3, answer({ score: 5, evidence: [7] }))).toMatchObject({
        score: 2,
        supported: false,
      });
    }
    for (const criterion of ['buildability', 'risk', 'reuse'] as const) {
      expect(toJudgement(criterion, 3, answer({ score: 5, evidence: [] }))).toMatchObject({
        score: 5,
        supported: false,
      });
    }
  });

  it('keeps at most three short concerns', () => {
    const judged = toJudgement(
      'risk',
      1,
      answer({ concerns: ['a', '', 'b', 'c', 'd', 'x'.repeat(300)] }),
    );
    expect(judged).toMatchObject({ concerns: ['a', 'b', 'c'] });
  });
});

describe('the panel result is computed by code (§2.13)', () => {
  const all = (score: number) =>
    Object.fromEntries(JUDGE_CRITERIA.map((criterion) => [criterion, score])) as Record<
      JudgeCriterion,
      number
    >;

  it('maps scores 1–5 to 0–100 and lists weak spots', () => {
    expect(judgePanel(all(5))).toMatchObject({ total: 100, weak: [], missing: [] });
    expect(judgePanel(all(1))).toMatchObject({ total: 0, weak: JUDGE_CRITERIA });
    expect(judgePanel(all(3)).total).toBe(50);
    const mixed = { ...all(4), risk: 2, reuse: 3 };
    // (3 + 3 + 3 + 3 + 1 + 2) / 24 = 0.625
    expect(judgePanel(mixed)).toMatchObject({ total: 63, weak: ['risk'] });
  });

  it('gives no total until every criterion is scored', () => {
    expect(judgePanel({ market: 4, risk: 2 })).toEqual({
      total: undefined,
      scores: { market: 4, risk: 2 },
      weak: ['risk'],
      missing: ['pain_value', 'economics', 'buildability', 'reuse'],
    });
  });

  it('shows the judges in /opportunities', () => {
    const judgement = (criterion: JudgeCriterion, score?: number): StoredJudgement => ({
      id: 1,
      occurredAt: toTimestamp(new Date()),
      opportunityId: '00000000-0000-7000-8000-000000000000' as StoredJudgement['opportunityId'],
      opportunityVersion: 1,
      criterion,
      taskVersion: 1,
      outcome: score === undefined ? 'failed' : 'judged',
      score,
      concerns: [],
      evidenceIds: [],
      actorType: 'agent',
      actorId: 'judges',
    });
    expect(
      judgesLines([
        judgement('market', 4),
        judgement('pain_value', 5),
        judgement('economics', 4),
        judgement('buildability', 5),
        judgement('risk', 2),
        judgement('reuse', 3),
      ]),
    ).toEqual([
      '   ⚖️ Судьи: 71/100 · рынок 4 · боль 5 · экономика 4 · сборка 5 · риск 2 · повтор 3',
      '   Слабые места: риск',
    ]);
    expect(judgesLines([judgement('market', 4), judgement('risk')])[0]).toBe(
      '   ⚖️ Судьи: оценивают · рынок 4 · боль — · экономика — · сборка — · риск — · повтор —',
    );
  });
});

describe('the judge task and its golden set (D-014 п.7)', () => {
  it('has 24 valid cases, four per criterion, with the criterion scale in the prompt', () => {
    const { evalCases } = judgeOpportunityTask;
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    for (const criterion of JUDGE_CRITERIA) {
      expect(evalCases.filter((c) => c.input.criterion === criterion)).toHaveLength(4);
    }
    for (const testCase of evalCases) {
      expect(judgeOpportunityTask.input.safeParse(testCase.input).success).toBe(true);
      expect(judgeOpportunityTask.render(testCase.input)).toContain(
        CRITERION_SCALES[testCase.input.criterion],
      );
    }
    // Both ends of the scale are in the set.
    expect(evalCases.filter((c) => c.expected.max <= 2).length).toBeGreaterThanOrEqual(6);
    expect(evalCases.filter((c) => c.expected.min >= 4).length).toBeGreaterThanOrEqual(6);
  });

  it('passes calibrated, cited answers and fails flat or uncited ones', () => {
    const { evalCases } = judgeOpportunityTask;
    const perfect = evalCases.map((c) => ({
      expected: c.expected,
      output: perfectJudgeAnswer(c.expected),
    }));
    expect(scoreJudge(perfect)).toEqual({
      passed: true,
      metrics: { in_range: 1, cited: 1, answered: 1 },
    });
    const flat = evalCases.map((c) => ({
      expected: c.expected,
      output: { ...perfectJudgeAnswer(c.expected), score: 3 },
    }));
    expect(scoreJudge(flat)).toMatchObject({ passed: false });
    const uncited = evalCases.map((c) => ({
      expected: c.expected,
      output: { ...perfectJudgeAnswer(c.expected), evidence: [] },
    }));
    expect(scoreJudge(uncited)).toMatchObject({ passed: false, metrics: { cited: 0 } });
  });

  it('runs on the strong models of all three providers', () => {
    expect(judgeOpportunityTask.tier).toBe('strong');
    expect(
      MODEL_REGISTRY.filter((model) => model.tier === 'strong').map((model) => model.provider),
    ).toEqual(['anthropic', 'openai', 'google']);
  });

  it('reserves the worst-case call on every strong model', () => {
    const worst = judgeOpportunityTask.instructions.length + 10_500;
    for (const model of MODEL_REGISTRY.filter((item) => item.tier === 'strong')) {
      expect(
        callCostMicroUsd(model, worst, judgeOpportunityTask.maxOutputTokens),
      ).toBeLessThanOrEqual(judgeOpportunityTask.maxCostMicroUsd);
    }
  });

  it('plans the whole day: all shares with evals add up to 1 (D-021)', () => {
    const tasks = [
      ...AI_TASKS,
      ...SIGNAL_TASKS,
      ...OPPORTUNITY_TASKS,
      ...AGENT_TASKS,
      ...JUDGE_TASKS,
      ...MEDIA_TASKS,
    ];
    expect(new Set(tasks.map((task) => task.name)).size).toBe(tasks.length);
    // Shares are whole percents; summed as such to avoid floating-point noise.
    const percent = (share: number) => Math.round(share * 100);
    expect(
      percent(EVAL_DAILY_SHARE) + tasks.reduce((sum, task) => sum + percent(task.dailyShare), 0),
    ).toBe(100);
    for (const task of tasks) {
      expect(task.dailyShare * 100).toBeCloseTo(percent(task.dailyShare), 9);
    }
  });
});
