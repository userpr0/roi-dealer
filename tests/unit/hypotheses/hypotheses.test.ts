import { describe, expect, it } from 'vitest';
import {
  designHypothesesTask,
  scoreDesignHypotheses,
  toHypothesisSet,
  type DesignHypothesesOutput,
} from '@roi-dealer/agents';
import { MIN_EVAL_CASES } from '@roi-dealer/ai-runtime';
import { perfectHypothesesAnswer } from '../../support/agent-answers.js';

const OPPORTUNITY = '00000000-0000-7000-8000-000000000001' as Parameters<typeof toHypothesisSet>[0];
const MARKETS = ['US', 'GB'];
const valid = () => perfectHypothesesAnswer({ markets: MARKETS, audience: 'Freelancers' });

/** Changes one hypothesis of a valid set. */
function withHypothesis(
  index: number,
  change: Partial<DesignHypothesesOutput['hypotheses'][number]>,
): DesignHypothesesOutput {
  const answer = valid();
  return {
    hypotheses: answer.hypotheses.map((item, at) => (at === index ? { ...item, ...change } : item)),
  };
}

const issuesOf = (answer: DesignHypothesesOutput) => {
  const checked = toHypothesisSet(OPPORTUNITY, MARKETS, answer);
  return 'issues' in checked ? checked.issues : [];
};

describe('five hypotheses are checked by code (PHASE 14, §7.1 B)', () => {
  it('accepts five complete, different tests and builds domain hypotheses', () => {
    const checked = toHypothesisSet(OPPORTUNITY, MARKETS, valid());
    expect('hypotheses' in checked).toBe(true);
    if (!('hypotheses' in checked)) return;
    expect(checked.hypotheses).toHaveLength(5);
    expect(checked.hypotheses[0]).toMatchObject({
      opportunityId: OPPORTUNITY,
      geo: 'US',
      price: { amountCents: 1_000, currency: 'USD' },
      budget: { amountCents: 5_000, currency: 'USD' },
      stopLoss: { amountCents: 2_000, currency: 'USD' },
      validationMethod: 'landing_page',
      successMetric: { name: 'lead', target: 20, unit: 'count', direction: 'at_least' },
    });
    // A rate: leads as a percentage of CTA clicks (PHASE 15 funnel).
    expect(checked.hypotheses[1]?.successMetric).toEqual({
      name: 'lead/cta_click',
      target: 10,
      unit: '%',
      direction: 'at_least',
    });
    expect(checked.hypotheses[4]?.price.amountCents).toBe(0);
  });

  it('names every issue of a hypothesis', () => {
    expect(issuesOf({ hypotheses: valid().hypotheses.slice(0, 4) })).toEqual([
      'expected 5 hypotheses, got 4',
    ]);
    expect(issuesOf(withHypothesis(1, { geo: 'DE' }))).toEqual([
      'hypothesis 2: geo DE is not one of US, GB',
    ]);
    expect(issuesOf(withHypothesis(0, { priceUsd: -1 }))).toEqual([
      'hypothesis 1: price must be between 0 and 10000 USD',
    ]);
    expect(issuesOf(withHypothesis(2, { budgetUsd: 150 }))).toEqual([
      'hypothesis 3: budget must be between 1 and 100 USD',
    ]);
    expect(issuesOf(withHypothesis(3, { stopLossUsd: 60 }))).toEqual([
      'hypothesis 4: stop-loss must be between 1 USD and the budget',
    ]);
    expect(
      issuesOf(withHypothesis(4, { successMetric: { stage: 'lead', per: 'none', target: 0 } })),
    ).toEqual(['hypothesis 5: success metric target must be above 0']);
    expect(
      issuesOf(withHypothesis(4, { successMetric: { stage: 'lead', per: 'payment', target: 5 } })),
    ).toEqual(['hypothesis 5: success metric base payment must come before lead in the funnel']);
    expect(
      issuesOf(
        withHypothesis(4, { successMetric: { stage: 'lead', per: 'cta_click', target: 120 } }),
      ),
    ).toEqual(['hypothesis 5: a rate target is a percentage, at most 100']);
    expect(issuesOf(withHypothesis(0, { cta: '  ' }))).toEqual(['hypothesis 1: cta is empty']);
  });

  it('needs different methods, prices, a demo and a total budget within $300', () => {
    const answer = valid();
    const same = (method: 'landing_page' | 'ads_test'): DesignHypothesesOutput => ({
      hypotheses: answer.hypotheses.map((item, index) => ({
        ...item,
        validationMethod: index < 3 ? method : ('interviews' as const),
        channel: `Channel ${String(index)}`,
      })),
    });
    expect(issuesOf(same('landing_page'))).toEqual(
      expect.arrayContaining([
        'use at least 3 different validation methods',
        'include a demo, clickable prototype or concierge test',
      ]),
    );
    expect(
      issuesOf({ hypotheses: answer.hypotheses.map((item) => ({ ...item, priceUsd: 20 })) }),
    ).toEqual(['use at least 2 different prices']);
    expect(
      issuesOf({ hypotheses: answer.hypotheses.map((item) => ({ ...item, budgetUsd: 70 })) }),
    ).toEqual(['total budget must be at most 300 USD']);
    // Two identical tests.
    const [first] = answer.hypotheses;
    expect(
      issuesOf({
        hypotheses: answer.hypotheses.map((item, index) =>
          index === 1 && first !== undefined ? { ...first } : item,
        ),
      }),
    ).toEqual(['two hypotheses are the same test (audience, geo, offer, price, channel, method)']);
  });
});

describe('the design-hypotheses task and its golden set (D-014 п.7)', () => {
  it('has at least 20 valid cases; perfect sets pass, broken ones fail', () => {
    const { evalCases } = designHypothesesTask;
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    for (const testCase of evalCases) {
      expect(designHypothesesTask.input.safeParse(testCase.input).success).toBe(true);
    }
    const perfect = evalCases.map((c) => ({
      expected: c.expected,
      output: perfectHypothesesAnswer({
        markets: c.expected.markets,
        audience: c.input.opportunity.icp,
      }),
    }));
    expect(scoreDesignHypotheses(perfect)).toEqual({
      passed: true,
      metrics: { valid: 1, relevant: 1, answered: 1 },
    });
    const offTopic = evalCases.map((c) => ({
      expected: c.expected,
      output: perfectHypothesesAnswer({ markets: c.expected.markets, audience: 'Everyone' }),
    }));
    expect(scoreDesignHypotheses(offTopic)).toMatchObject({ passed: false });
    const broken = evalCases.map((c) => ({ expected: c.expected, output: { hypotheses: [] } }));
    expect(scoreDesignHypotheses(broken).metrics['valid']).toBe(0);
  });

  it('asks for honest tests and the smallest product', () => {
    expect(designHypothesesTask.instructions).toContain('coming soon');
    expect(designHypothesesTask.instructions).toContain('refund');
    expect(designHypothesesTask.tier).toBe('bulk');
    const [first] = designHypothesesTask.evalCases;
    if (first === undefined) throw new Error('no golden cases');
    const prompt = designHypothesesTask.render({
      ...first.input,
      feedback: 'use at least 2 different prices',
    });
    expect(prompt).toContain(
      'Fix these issues of your previous answer: use at least 2 different prices',
    );
  });
});
