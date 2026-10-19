import { describe, expect, it } from 'vitest';
import {
  approvalRequestIdSchema,
  approveExperiment,
  automaticStopReason,
  changeHypothesisStatus,
  confirmHonestChecks,
  costEntryIdSchema,
  createApprovalRequest,
  createExperiment,
  createHypothesis,
  EXPERIMENT_CALENDAR_DAYS,
  experimentDay,
  experimentIdSchema,
  funnelMetric,
  honestChecklist,
  hypothesisIdSchema,
  hypothesisVerdict,
  metricReached,
  metricValue,
  opportunityIdSchema,
  planExperiment,
  readFunnelMeasure,
  recordExperimentCost,
  requestExperimentApproval,
  resolveApprovalRequest,
  startExperiment,
  STOP_REASONS,
  stopExperiment,
  usd,
  type Experiment,
  type Hypothesis,
  type NewHypothesis,
} from '@roi-dealer/domain';
import { metricText, parseFunnelReport } from '@roi-dealer/command-center';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at, createCtx, ctx, hypothesisData, OWNER, SYSTEM } from '../../support/domain.js';

const OPPORTUNITY = opportunityIdSchema.parse(uuidv7());
const LEADS = funnelMetric({ stage: 'lead' }, 20);

function hypothesis(overrides: Partial<NewHypothesis> = {}): Hypothesis {
  const proposed = createHypothesis(
    hypothesisData(OPPORTUNITY, { successMetric: LEADS, ...overrides }),
    createCtx(hypothesisIdSchema, AGENT, 1),
  );
  return changeHypothesisStatus(proposed, 'selected', ctx(OWNER, 2));
}

/** A planned test of a $200 hypothesis with a $100 stop-loss, the checklist confirmed. */
function planned(selected = hypothesis()): Experiment {
  const experiment = createExperiment(
    planExperiment(selected),
    selected,
    createCtx(experimentIdSchema, OWNER, 3),
  );
  return confirmHonestChecks(experiment, selected, ctx(OWNER, 4));
}

function launch(experiment: Experiment, kind: 'experiment_launch' | 'spend' = 'experiment_launch') {
  const request = createApprovalRequest(
    {
      kind,
      title: 'Launch',
      summary: 'Test budget',
      amount: usd(20_000),
      subject: { type: 'experiment', id: experiment.id },
      expiresAt: at(600),
    },
    createCtx(approvalRequestIdSchema, OWNER, 5),
  );
  return resolveApprovalRequest(request, { decision: 'approve' }, ctx(OWNER, 6));
}

function running(): { experiment: Experiment; approval: ReturnType<typeof launch> } {
  const experiment = planned();
  const approval = launch(experiment);
  const awaiting = requestExperimentApproval(experiment, approval.id, ctx(OWNER, 5));
  return {
    experiment: startExperiment(
      approveExperiment(awaiting, approval, ctx(OWNER, 7)),
      ctx(OWNER, 8),
    ),
    approval,
  };
}

describe('the funnel metric (PHASE 15, D-014 п.9)', () => {
  it('reads counts and rates of funnel stages, nothing else', () => {
    expect(readFunnelMeasure(LEADS)).toEqual({ stage: 'lead' });
    const rate = funnelMetric({ stage: 'payment', per: 'cta_click' }, 5);
    expect(rate).toEqual({
      name: 'payment/cta_click',
      target: 5,
      unit: '%',
      direction: 'at_least',
    });
    expect(readFunnelMeasure(rate)).toEqual({ stage: 'payment', per: 'cta_click' });
    for (const metric of [
      { name: 'signups', target: 20, unit: 'count', direction: 'at_least' },
      { name: 'lead', target: 20, unit: 'people', direction: 'at_least' },
      { name: 'lead', target: 20, unit: 'count', direction: 'at_most' },
      { name: 'cta_click/payment', target: 5, unit: '%', direction: 'at_least' },
      { name: 'payment/cta_click', target: 150, unit: '%', direction: 'at_least' },
      { name: 'lead/attention/impression', target: 5, unit: '%', direction: 'at_least' },
    ] as const) {
      expect(readFunnelMeasure(metric)).toBeUndefined();
    }
  });

  it('computes the value from the totals the same way for every test', () => {
    const totals = { impression: 1_200, cta_click: 40, lead: 7 };
    expect(metricValue(LEADS, totals)).toBe(7);
    expect(metricValue(funnelMetric({ stage: 'lead', per: 'cta_click' }, 10), totals)).toBe(17.5);
    expect(metricValue(funnelMetric({ stage: 'lead', per: 'impression' }, 1), totals)).toBe(0.58);
    // A rate without its base has no value yet.
    expect(metricValue(funnelMetric({ stage: 'lead', per: 'attention' }, 1), totals)).toBe(
      undefined,
    );
    expect(metricReached(LEADS, 20)).toBe(true);
    expect(metricReached(LEADS, 19)).toBe(false);
    expect(metricReached(LEADS, undefined)).toBe(false);
    expect(metricText(LEADS)).toBe('заявки ≥ 20');
    expect(metricText(funnelMetric({ stage: 'lead', per: 'cta_click' }, 10))).toBe(
      'заявки / клики CTA ≥ 10 %',
    );
  });
});

describe('the honest-test checklist (D-014 п.8, §7.2)', () => {
  const always = ['no_fabrication', 'channel_rules', 'funnel_tracking'];

  it('depends on the method and the price', () => {
    expect(honestChecklist(hypothesis())).toEqual([...always, 'fake_door_disclosed', 'page_legal']);
    expect(honestChecklist(hypothesis({ validationMethod: 'preorder' }))).toEqual([
      ...always,
      'page_legal',
      'refund_terms',
      'payment_tested',
    ]);
    expect(honestChecklist(hypothesis({ validationMethod: 'concierge' }))).toEqual([
      ...always,
      'refund_terms',
    ]);
    expect(honestChecklist(hypothesis({ validationMethod: 'concierge', price: usd(0) }))).toEqual(
      always,
    );
    expect(honestChecklist(hypothesis({ validationMethod: 'outreach' }))).toEqual([
      ...always,
      'outreach_rules',
    ]);
    expect(honestChecklist(hypothesis({ validationMethod: 'clickable_prototype' }))).toEqual([
      ...always,
      'crash_test',
    ]);
  });

  it('is confirmed by the owner while planning; nothing starts without it', () => {
    const selected = hypothesis();
    const experiment = createExperiment(
      planExperiment(selected),
      selected,
      createCtx(experimentIdSchema, OWNER, 3),
    );
    expect(experiment).toMatchObject({ honestChecks: [], status: 'planned' });
    expect(() => confirmHonestChecks(experiment, selected, ctx(AGENT, 4))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
    const checked = confirmHonestChecks(experiment, selected, ctx(OWNER, 4));
    expect(checked).toMatchObject({
      honestChecks: honestChecklist(selected),
      checksConfirmedAt: at(4),
      version: 2,
      status: 'planned',
    });

    // An approved launch without the checklist does not start.
    const approval = launch(experiment);
    const approved = approveExperiment(
      requestExperimentApproval(experiment, approval.id, ctx(OWNER, 5)),
      approval,
      ctx(OWNER, 7),
    );
    expect(() => startExperiment(approved, ctx(OWNER, 8))).toThrow(/honest-test checklist/);
    expect(() => confirmHonestChecks(approved, selected, ctx(OWNER, 8))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});

describe('the experiment plan (§7.1 C–D)', () => {
  it('picks the smallest artifact, no build money, the hypothesis budget and metric', () => {
    const selected = hypothesis();
    expect(planExperiment(selected)).toMatchObject({
      opportunityId: OPPORTUNITY,
      hypothesisId: selected.id,
      artifact: 'landing',
      buildBudget: {
        maxMoney: usd(0),
        maxAiCost: usd(0),
        maxHumanHours: 4,
        maxCalendarDays: EXPERIMENT_CALENDAR_DAYS,
      },
      testBudget: usd(20_000),
      stopLoss: usd(10_000),
      successMetric: LEADS,
      killCriteria:
        'Stop when $100.00 is spent and lead is below 20, when $200.00 is spent, or after 14 days.',
    });
    expect(planExperiment(hypothesis({ validationMethod: 'concierge' })).artifact).toBe(
      'concierge',
    );
    expect(planExperiment(hypothesis({ validationMethod: 'interviews' })).artifact).toBe('other');
  });

  it('refuses a metric the funnel cannot measure', () => {
    expect(() =>
      planExperiment(
        hypothesis({
          successMetric: { name: 'happiness', target: 5, unit: 'stars', direction: 'at_least' },
        }),
      ),
    ).toThrow(/not a funnel measure/);
  });
});

describe('spend, stop-loss and the verdict (§2.19, §7.3)', () => {
  it('records spend only within the approved launch', () => {
    const { experiment, approval } = running();
    const entry = recordExperimentCost(
      { amount: usd(5_000), description: 'Ads', incurredAt: at(9) },
      experiment,
      approval,
      usd(0),
      createCtx(costEntryIdSchema, OWNER, 9),
    );
    expect(entry).toMatchObject({
      category: 'ads',
      recurring: false,
      approvalRequestId: approval.id,
      allocation: {
        opportunityId: OPPORTUNITY,
        hypothesisId: experiment.hypothesisId,
        experimentId: experiment.id,
      },
    });
    const spend =
      (spent: number, approvalOf = approval) =>
      () =>
        recordExperimentCost(
          { amount: usd(5_000), description: 'Ads', incurredAt: at(9) },
          experiment,
          approvalOf,
          usd(spent),
          createCtx(costEntryIdSchema, OWNER, 9),
        );
    // $150 spent + $50 = the whole $200 budget; one cent more needs a new approval.
    expect(spend(15_000)).not.toThrow();
    expect(spend(15_001)).toThrow(expect.objectContaining({ code: 'approval_required' }));
    expect(spend(0, launch(experiment, 'spend'))).toThrow(
      expect.objectContaining({ code: 'approval_required' }),
    );
    expect(() =>
      recordExperimentCost(
        { amount: usd(100), description: 'Ads', incurredAt: at(9) },
        planned(),
        approval,
        usd(0),
        createCtx(costEntryIdSchema, OWNER, 9),
      ),
    ).toThrow(/Only a launched experiment/);
  });

  it('stops at the stop-loss without success and at the end of the budget', () => {
    const { experiment } = running();
    expect(automaticStopReason(experiment, usd(9_999), false)).toBeUndefined();
    expect(automaticStopReason(experiment, usd(10_000), false)).toBe(STOP_REASONS.stopLoss);
    expect(automaticStopReason(experiment, usd(10_000), true)).toBeUndefined();
    expect(automaticStopReason(experiment, usd(20_000), true)).toBe(STOP_REASONS.budget);
    expect(automaticStopReason(planned(), usd(20_000), false)).toBeUndefined();
  });

  it('judges the hypothesis from the data', () => {
    const { experiment } = running();
    expect(hypothesisVerdict(experiment, true)).toBe('confirmed');
    expect(hypothesisVerdict(experiment, false)).toBe('inconclusive');
    const lost = stopExperiment(experiment, STOP_REASONS.stopLoss, ctx(SYSTEM, 60));
    expect(hypothesisVerdict(lost, false)).toBe('refuted');
    expect(
      hypothesisVerdict(stopExperiment(experiment, STOP_REASONS.owner, ctx(OWNER, 60)), false),
    ).toBe('inconclusive');
  });

  it('counts the days of a test and marks it overdue', () => {
    const { experiment } = running();
    expect(experimentDay(planned(), at(9))).toBeUndefined();
    expect(experimentDay(experiment, at(8))).toEqual({ day: 1, overdue: false });
    expect(experimentDay(experiment, at(8 + 13 * 24 * 60))).toEqual({ day: 14, overdue: false });
    expect(experimentDay(experiment, at(8 + 14 * 24 * 60))).toEqual({ day: 15, overdue: true });
  });
});

describe('/funnel reports (PHASE 15)', () => {
  it('reads the test number, stage increments in Russian or English and spend', () => {
    expect(parseFunnelReport('1 клики 40 заявки 5 $12.50')).toEqual({
      number: 1,
      increments: { cta_click: 40, lead: 5 },
      spendCents: 1_250,
      revenueCents: 0,
      refundCents: 0,
    });
    expect(parseFunnelReport('№2 impressions 1200 leads 3 lead 2 spent 7,5')).toEqual({
      number: 2,
      increments: { impression: 1_200, lead: 5 },
      spendCents: 750,
      revenueCents: 0,
      refundCents: 0,
    });
    expect(parseFunnelReport('3 $5')).toEqual({
      number: 3,
      increments: {},
      spendCents: 500,
      revenueCents: 0,
      refundCents: 0,
    });
  });

  it('explains what is wrong', () => {
    expect(parseFunnelReport('')).toContain('/funnel <№>');
    expect(parseFunnelReport('клики 40')).toContain('Сначала номер теста');
    expect(parseFunnelReport('1 лайки 40')).toContain('Не знаю шаг «лайки»');
    expect(parseFunnelReport('1 клики сорок')).toContain('целое число');
    expect(parseFunnelReport('1 клики 0')).toContain('целое число');
    expect(parseFunnelReport('1 $-5')).toContain('Траты — от $0.01');
    expect(parseFunnelReport('1')).toContain('Нет ни цифр, ни трат');
  });
});
