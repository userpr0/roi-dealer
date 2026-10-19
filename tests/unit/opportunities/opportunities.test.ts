import { describe, expect, it } from 'vitest';
import {
  AI_TASKS,
  callCostMicroUsd,
  EVAL_DAILY_SHARE,
  MIN_EVAL_CASES,
  MODEL_REGISTRY,
} from '@roi-dealer/ai-runtime';
import { createPain, evidenceIdSchema, painIdSchema, signalIdSchema } from '@roi-dealer/domain';
import {
  frameOpportunityTask,
  OPPORTUNITY_TASKS,
  OPPORTUNITY_THRESHOLD,
  opportunityFrom,
  routeBusinessModel,
  SCORE_WEIGHTS,
  scoreFrameOpportunity,
  scoreOpportunity,
  toOpportunityDraft,
  verifiedQuotes,
  type FrameOpportunityOutput,
} from '@roi-dealer/opportunities';
import { uuidv7 } from '@roi-dealer/shared';
import { SIGNAL_TASKS } from '@roi-dealer/signals';
import { AGENT, createCtx } from '../../support/domain.js';

const EXCERPTS = [
  'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
  'Reconciling Stripe payouts with QuickBooks takes our accountant 6 hours a week.',
];

const answer = (overrides: Partial<FrameOpportunityOutput> = {}): FrameOpportunityOutput => ({
  title: 'Payouts that reconcile themselves for small agencies',
  summary: 'Small agencies spend hours matching payouts with their books.',
  icp: 'Agencies with 2–20 people on Stripe and QuickBooks',
  problem: 'Payouts do not match the books',
  change: 'Payouts are matched automatically every day',
  measurableResult: 'Six hours a week saved on reconciliation',
  buyer: 'business',
  recurring: true,
  urgency: 'medium',
  serviceHeavy: false,
  paymentQuotes: ['We pay a bookkeeper $400 a month'],
  pricingHypothesis: '$49 a month, less than an hour of bookkeeping',
  ...overrides,
});

describe('opportunity score (§2.13: computed in code)', () => {
  it('has weights that add up to 100 and a threshold of 55', () => {
    expect(Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(100);
    expect(OPPORTUNITY_THRESHOLD).toBe(55);
  });

  it('scores a recurring business pain with a money quote above the threshold', () => {
    expect(
      scoreOpportunity({
        pain: { frequency: 'occasional', severity: 3, markets: ['US'] },
        sources: 1,
        verifiedPaymentQuotes: 1,
        buyer: 'business',
      }),
    ).toEqual({
      total: 62,
      components: {
        frequency: 12.5,
        severity: 10,
        sources: 7.5,
        willingness: 12,
        market: 10,
        buyer: 10,
      },
    });
  });

  it('keeps a weak consumer pain outside the target markets far below it', () => {
    const { total, components } = scoreOpportunity({
      pain: { frequency: 'rare', severity: 2, markets: ['DE'] },
      sources: 1,
      verifiedPaymentQuotes: 0,
      buyer: 'consumer',
    });
    expect(components).toMatchObject({ willingness: 0, market: 3, buyer: 5 });
    expect(total).toBe(27);
  });

  it('gives the full score to a constant, severe, proven, multi-source business pain', () => {
    expect(
      scoreOpportunity({
        pain: { frequency: 'constant', severity: 5, markets: ['GB', 'DE'] },
        sources: 3,
        verifiedPaymentQuotes: 2,
        buyer: 'business',
      }).total,
    ).toBe(100);
  });
});

describe('Business Model Router (§2.18: the first hypothesis)', () => {
  it.each([
    [{ buyer: 'business', recurring: true, urgency: 'high', serviceHeavy: true }, 'service'],
    [{ buyer: 'consumer', recurring: false, urgency: 'low', serviceHeavy: true }, 'service'],
    [{ buyer: 'business', recurring: true, urgency: 'low', serviceHeavy: false }, 'subscription'],
    [{ buyer: 'business', recurring: false, urgency: 'high', serviceHeavy: false }, 'one_time'],
    [{ buyer: 'consumer', recurring: true, urgency: 'low', serviceHeavy: false }, 'free_limit'],
    [{ buyer: 'consumer', recurring: true, urgency: 'high', serviceHeavy: false }, 'subscription'],
    [{ buyer: 'consumer', recurring: false, urgency: 'medium', serviceHeavy: false }, 'one_time'],
  ] as const)('%o → %s', (features, model) => {
    expect(routeBusinessModel(features).model).toBe(model);
  });
});

describe('code checks what the model proposes (§2.3, §2.5)', () => {
  it('keeps only money quotes found in the evidence, without quote marks, at most three', () => {
    expect(
      verifiedQuotes(
        [
          '"We pay a bookkeeper $400 a month"',
          'We lose a million dollars a year',
          'we pay a bookkeeper $400 a month',
          'takes our accountant 6 hours',
          'match payouts by hand',
          'Reconciling Stripe payouts',
        ],
        EXCERPTS,
      ),
    ).toEqual([
      // The same quote in another case counts once.
      'we pay a bookkeeper $400 a month',
      'takes our accountant 6 hours',
      'match payouts by hand',
    ]);
  });

  it('rejects an incomplete value proposition and fills optional parts', () => {
    expect(toOpportunityDraft(EXCERPTS, answer({ problem: ' ' }))).toBe('rejected');
    expect(toOpportunityDraft(EXCERPTS, answer({ title: 'Short' }))).toBe('rejected');
    expect(
      toOpportunityDraft(EXCERPTS, answer({ summary: '', icp: '', pricingHypothesis: '' })),
    ).toMatchObject({
      summary: 'Payouts do not match the books',
      icp: '',
      pricingHypothesis: undefined,
    });
  });

  it('builds the opportunity: score and model in the summary, verified proof, ICP fallback', () => {
    const pain = createPain(
      {
        title: 'Agencies reconcile payouts by hand',
        description: 'Payouts',
        audience: 'Small agencies',
        desiredOutcome: 'Books match payouts',
        severity: 3,
        frequency: 'occasional',
        markets: ['US'],
        signalIds: [signalIdSchema.parse(uuidv7()), signalIdSchema.parse(uuidv7())],
        evidenceIds: [evidenceIdSchema.parse(uuidv7())],
      },
      createCtx(painIdSchema, AGENT),
    );
    const draft = toOpportunityDraft(EXCERPTS, answer({ icp: '' }));
    if (draft === 'rejected') throw new Error('rejected');
    const score = scoreOpportunity({
      pain,
      sources: 1,
      verifiedPaymentQuotes: 1,
      buyer: 'business',
    });
    const { data, reason } = opportunityFrom(pain, draft, score);
    expect(reason).toBe('business_recurring');
    expect(data).toMatchObject({
      painIds: [pain.id],
      icp: 'Small agencies',
      markets: ['US'],
      businessModel: { model: 'subscription', pricingHypothesis: draft.pricingHypothesis },
      valueProposition: { proof: '"We pay a bookkeeper $400 a month"' },
    });
    expect(data.summary).toContain('Score 62/100 (frequency 12.5, severity 10');
    expect(data.summary).toContain('Business model: subscription');
  });
});

describe('golden set of frame-opportunity (D-014 п.7)', () => {
  const { evalCases } = frameOpportunityTask;
  const perfect = evalCases.map((c) => ({
    expected: c.expected,
    output: answer({
      buyer: c.expected.buyer,
      recurring: c.expected.recurring,
      paymentQuotes: c.expected.paying ? [(c.expected.excerpts.at(-1) ?? '').slice(0, 40)] : [],
    }),
  }));

  it('has 20 valid cases with both kinds of buyers, recurrences and payments', () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    for (const testCase of evalCases) {
      expect(frameOpportunityTask.input.safeParse(testCase.input).success).toBe(true);
    }
    for (const pick of [
      (c: (typeof evalCases)[number]) => c.expected.buyer === 'consumer',
      (c: (typeof evalCases)[number]) => !c.expected.recurring,
      (c: (typeof evalCases)[number]) => !c.expected.paying,
    ]) {
      expect(evalCases.filter(pick).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('perfect answers pass deterministically; wrong buyers and invented quotes fail', () => {
    expect(scoreFrameOpportunity(perfect)).toEqual(scoreFrameOpportunity(perfect));
    expect(scoreFrameOpportunity(perfect)).toEqual({
      passed: true,
      metrics: { buyer: 1, recurring: 1, payment: 1, complete: 1, answered: 1 },
    });
    const allBusiness = perfect.map((item) => ({
      ...item,
      output: { ...item.output, buyer: 'business' as const },
    }));
    expect(scoreFrameOpportunity(allBusiness).passed).toBe(false);
    const invented = perfect.map((item) => ({
      ...item,
      output: { ...item.output, paymentQuotes: ['We spend a fortune on this'] },
    }));
    expect(scoreFrameOpportunity(invented)).toMatchObject({ passed: false });
  });

  it('all AI tasks together keep their shares of the day within 1 (D-021)', () => {
    const tasks = [...AI_TASKS, ...SIGNAL_TASKS, ...OPPORTUNITY_TASKS];
    expect(new Set(tasks.map((task) => task.name)).size).toBe(tasks.length);
    expect(
      tasks.reduce((sum, task) => sum + task.dailyShare, EVAL_DAILY_SHARE),
    ).toBeLessThanOrEqual(1);
  });

  it('reserves at least the worst-case cost of one call on every bulk model', () => {
    const worstInput = frameOpportunityTask.instructions.length + 8 * 1_010 + 1_300;
    for (const model of MODEL_REGISTRY.filter((item) => item.tier === 'bulk')) {
      expect(
        callCostMicroUsd(model, worstInput, frameOpportunityTask.maxOutputTokens),
      ).toBeLessThanOrEqual(frameOpportunityTask.maxCostMicroUsd);
    }
  });
});
