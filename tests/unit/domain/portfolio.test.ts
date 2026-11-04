import { describe, expect, it } from 'vitest';
import {
  approveExperiment,
  approvalRequestIdSchema,
  automaticStopReason,
  betaCdf,
  changeHypothesisStatus,
  confirmHonestChecks,
  countReachProbability,
  createApprovalRequest,
  createExperiment,
  createHypothesis,
  experimentIdSchema,
  experimentTotalBudget,
  hypothesisIdSchema,
  hypothesisVerdict,
  opportunityIdSchema,
  proposeExperimentOutcome,
  rateAtLeastProbability,
  recommendPortfolio,
  requestExperimentApproval,
  resolveApprovalRequest,
  startExperiment,
  STOP_REASONS,
  stopExperiment,
  stoppingEvidence,
  usd,
  type Experiment,
  type Metric,
  type PortfolioCandidate,
} from '@roi-dealer/domain';
import { parseAllocate } from '@roi-dealer/command-center';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  experimentData,
  hypothesisData,
  OWNER,
  SYSTEM,
} from '../../support/domain.js';

const LEADS: Metric = { name: 'lead', target: 20, unit: 'count', direction: 'at_least' };
const SIGNUP_RATE: Metric = {
  name: 'lead/cta_click',
  target: 5,
  unit: '%',
  direction: 'at_least',
};

describe('statistics of stopping (phase 26)', () => {
  it('computes the beta distribution exactly where it has a closed form', () => {
    expect(betaCdf(0.5, 2, 2)).toBeCloseTo(0.5, 10);
    expect(betaCdf(0.37, 1, 1)).toBeCloseTo(0.37, 10);
    // I_x(2, b) = 1 − (1 − x)^b (1 + b·x)
    expect(betaCdf(0.3, 2, 5)).toBeCloseTo(1 - 0.7 ** 5 * 2.5, 10);
    expect(betaCdf(0, 3, 4)).toBe(0);
    expect(betaCdf(1, 3, 4)).toBe(1);
  });

  it('says how likely a rate is to be at least its target', () => {
    expect(rateAtLeastProbability(2, 200, 0.05)).toBeLessThan(0.01);
    expect(rateAtLeastProbability(20, 200, 0.05)).toBeGreaterThan(0.99);
  });

  it('says how likely a count is to reach its target with the budget left', () => {
    // No events after a quarter of the budget: geometric, (1 − 0.25)^20.
    expect(countReachProbability(0, 20, 1_250, 3_750)).toBeCloseTo(0.75 ** 20, 10);
    expect(countReachProbability(4, 20, 1_250, 3_750)).toBeCloseTo(0.4148, 3);
    expect(countReachProbability(20, 20, 1_250, 3_750)).toBe(1);
    expect(countReachProbability(5, 20, 5_000, 0)).toBe(0);
  });

  it('needs enough data before the evidence may stop a test', () => {
    expect(stoppingEvidence(SIGNUP_RATE, { cta_click: 60, lead: 0 }, 0, 5_000)).toMatchObject({
      enoughData: false,
    });
    expect(stoppingEvidence(SIGNUP_RATE, { cta_click: 150, lead: 1 }, 0, 5_000)).toMatchObject({
      enoughData: true,
    });
    expect(stoppingEvidence(LEADS, { lead: 0 }, 1_000, 5_000)).toMatchObject({
      enoughData: false,
    });
    expect(stoppingEvidence(LEADS, { lead: 0 }, 0, 5_000)).toBeUndefined();
    expect(stoppingEvidence(LEADS, { lead: 25 }, 100, 5_000)).toEqual({
      probability: 1,
      enoughData: true,
    });
    const other: Metric = {
      name: 'waitlist conversion',
      target: 5,
      unit: '%',
      direction: 'at_least',
    };
    expect(stoppingEvidence(other, {}, 1_000, 5_000)).toBeUndefined();
  });
});

const opportunityId = opportunityIdSchema.parse('0190c5a6-7b8e-7c3d-9f00-123456789abc');

function runningLeadsTest(): Experiment {
  const proposed = createHypothesis(
    hypothesisData(opportunityId, {
      budget: usd(5_000),
      stopLoss: usd(2_000),
      successMetric: LEADS,
    }),
    createCtx(hypothesisIdSchema, AGENT),
  );
  const hypothesis = changeHypothesisStatus(proposed, 'selected', ctx(OWNER, 1));
  const planned = confirmHonestChecks(
    createExperiment(
      experimentData(opportunityId, hypothesis.id, {
        testBudget: usd(5_000),
        stopLoss: usd(2_000),
        successMetric: LEADS,
      }),
      hypothesis,
      createCtx(experimentIdSchema, AGENT, 2),
    ),
    hypothesis,
    ctx(OWNER, 2),
  );
  const request = resolveApprovalRequest(
    createApprovalRequest(
      {
        kind: 'experiment_launch',
        title: 'Launch',
        summary: 'Budget',
        amount: experimentTotalBudget(planned),
        subject: { type: 'experiment', id: planned.id },
        expiresAt: at(600),
      },
      createCtx(approvalRequestIdSchema, SYSTEM, 3),
    ),
    { decision: 'approve' },
    ctx(OWNER, 4),
  );
  return startExperiment(
    approveExperiment(
      requestExperimentApproval(planned, request.id, ctx(SYSTEM, 3)),
      request,
      ctx(OWNER, 5),
    ),
    ctx(SYSTEM, 6),
  );
}

describe('the early stop of a clearly losing test', () => {
  it('stops before the stop-loss when the target is out of reach, and not on thin data', () => {
    const running = runningLeadsTest();
    // A quarter of the budget, no leads: under 1 % to reach 20.
    expect(automaticStopReason(running, usd(1_250), false, { lead: 0 })).toBe(
      STOP_REASONS.futility,
    );
    // The same pace but too little spend yet.
    expect(automaticStopReason(running, usd(1_000), false, { lead: 0 })).toBeUndefined();
    // On pace: four leads after a quarter — about 41 %, the test goes on.
    expect(automaticStopReason(running, usd(1_250), false, { lead: 4 })).toBeUndefined();
    // Without the funnel numbers only the money rules apply.
    expect(automaticStopReason(running, usd(1_250), false)).toBeUndefined();
    expect(automaticStopReason(running, usd(2_000), false, { lead: 10 })).toBe(
      STOP_REASONS.stopLoss,
    );
  });

  it('counts the early stop as a refuted hypothesis and proposes a pivot', () => {
    const stopped = stopExperiment(runningLeadsTest(), STOP_REASONS.futility, ctx(SYSTEM, 9));
    expect(hypothesisVerdict(stopped, false)).toBe('refuted');
    expect(proposeExperimentOutcome(stopped, false, at(10))).toBe('pivot');
  });
});

const candidate = (
  id: string,
  overrides: Partial<PortfolioCandidate> = {},
): PortfolioCandidate => ({
  hypothesisId: id,
  opportunityId: 'opp-a',
  geo: 'US',
  budgetCents: 5_000,
  score: 60,
  confirmed: 0,
  refuted: 0,
  ...overrides,
});

describe('the portfolio of tests (Thompson sampling)', () => {
  const limits = { totalCents: 30_000, countryCents: 15_000, opportunityCents: 10_000 };
  const empty = { totalCents: 0, byCountry: {}, byOpportunity: {} };

  it('gives the same advice within a month and keeps every limit', () => {
    const candidates = [
      candidate('h1'),
      candidate('h2'),
      candidate('h3', { opportunityId: 'opp-b' }),
      candidate('h4', { opportunityId: 'opp-b', geo: 'GB' }),
      candidate('h5', { opportunityId: 'opp-c', geo: 'GB' }),
    ];
    const first = recommendPortfolio({ month: '2026-11', limits, committed: empty, candidates });
    const again = recommendPortfolio({
      month: '2026-11',
      limits,
      committed: empty,
      candidates: [...candidates].reverse(),
    });
    expect(again).toEqual(first);

    const spent = (key: 'geo' | 'opportunityId', value: string) =>
      first.picks
        .filter((pick) => pick.candidate[key] === value)
        .reduce((sum, pick) => sum + pick.candidate.budgetCents, 0);
    expect(spent('geo', 'US')).toBeLessThanOrEqual(limits.countryCents);
    expect(spent('opportunityId', 'opp-a')).toBeLessThanOrEqual(limits.opportunityCents);
    expect(first.picks.length + first.skipped.length).toBe(5);
    // Three of the five fit the US limit of $150 together with the GB ones.
    expect(
      first.picks.map((pick) => pick.candidate.geo).filter((geo) => geo === 'US'),
    ).toHaveLength(3);
  });

  it('reads the month budget already taken and names why a test does not fit', () => {
    const advice = recommendPortfolio({
      month: '2026-11',
      limits,
      committed: { totalCents: 27_000, byCountry: { US: 1_000 }, byOpportunity: {} },
      candidates: [candidate('h1'), candidate('h2', { budgetCents: 2_000 })],
    });
    expect(advice.picks.map((pick) => pick.candidate.hypothesisId)).toEqual(['h2']);
    expect(advice.skipped).toEqual([expect.objectContaining({ reason: 'total' })]);
    expect(advice.freeCents).toBe(1_000);
  });

  it('gives a higher chance to an opportunity whose tests succeeded', () => {
    const advice = recommendPortfolio({
      month: '2026-11',
      limits,
      committed: empty,
      candidates: [
        candidate('h1', { confirmed: 3 }),
        candidate('h2', { opportunityId: 'opp-b', refuted: 3 }),
      ],
    });
    const chance = (id: string) =>
      advice.picks.find((pick) => pick.candidate.hypothesisId === id)?.chance ?? 0;
    expect(chance('h1')).toBe(0.743);
    expect(chance('h2')).toBe(0.314);
  });
});

describe('/allocate', () => {
  it('reads the month budget and the limits, defaulting the limits to the budget', () => {
    expect(parseAllocate('300 страна 150 возможность 100')).toEqual({
      totalCents: 30_000,
      countryCents: 15_000,
      opportunityCents: 10_000,
    });
    expect(parseAllocate('$250.50')).toEqual({
      totalCents: 25_050,
      countryCents: 25_050,
      opportunityCents: 25_050,
    });
    expect(parseAllocate('200 ниша 50')).toMatchObject({ opportunityCents: 5_000 });
    expect(parseAllocate('много')).toContain('/allocate 300 страна 150 возможность 100');
    expect(parseAllocate('100 страна 200')).toContain('⛔');
  });
});
