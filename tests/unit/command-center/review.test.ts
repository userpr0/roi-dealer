import { describe, expect, it } from 'vitest';
import {
  changeHypothesisStatus,
  confirmHonestChecks,
  createExperiment,
  createHypothesis,
  experimentIdSchema,
  funnelMetric,
  hypothesisIdSchema,
  opportunityIdSchema,
  planExperiment,
  proposeExperimentOutcome,
  STOP_REASONS,
  stopExperiment,
  type Experiment,
} from '@roi-dealer/domain';
import { isReviewDay } from '@roi-dealer/command-center';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at, createCtx, ctx, hypothesisData, OWNER } from '../../support/domain.js';

const DAY_MINUTES = 24 * 60;

function experiment(status: 'planned' | 'running'): Experiment {
  const selected = changeHypothesisStatus(
    createHypothesis(
      hypothesisData(opportunityIdSchema.parse(uuidv7()), {
        successMetric: funnelMetric({ stage: 'lead' }, 20),
      }),
      createCtx(hypothesisIdSchema, AGENT, 1),
    ),
    'selected',
    ctx(OWNER, 2),
  );
  const planned = confirmHonestChecks(
    createExperiment(planExperiment(selected), selected, createCtx(experimentIdSchema, OWNER, 3)),
    selected,
    ctx(OWNER, 4),
  );
  // A running test started at minute 10 (the launch itself is covered by PHASE 15 tests).
  return status === 'planned' ? planned : { ...planned, status: 'running', startedAt: at(10) };
}

describe('the weekly review proposals (PHASE 13, D-014 п.12)', () => {
  it('proposes scale, pivot or improve by the data; nothing while data is collected', () => {
    const running = experiment('running');
    expect(proposeExperimentOutcome(running, true, at(20))).toBe('scale');
    expect(proposeExperimentOutcome(running, false, at(20))).toBeUndefined();
    // Past the 14 days of the test without the metric.
    expect(proposeExperimentOutcome(running, false, at(10 + 14 * DAY_MINUTES))).toBe('improve');
    const lost = stopExperiment(running, STOP_REASONS.stopLoss, ctx(OWNER, 30));
    expect(proposeExperimentOutcome(lost, false, at(40))).toBe('pivot');
    expect(proposeExperimentOutcome(lost, true, at(40))).toBe('scale');
    const byOwner = stopExperiment(running, STOP_REASONS.owner, ctx(OWNER, 30));
    expect(proposeExperimentOutcome(byOwner, false, at(40))).toBeUndefined();
    expect(proposeExperimentOutcome(experiment('planned'), true, at(40))).toBeUndefined();
  });

  it('comes on Mondays by the Kyiv calendar', () => {
    expect(isReviewDay('2026-10-19')).toBe(true);
    expect(isReviewDay('2026-10-20')).toBe(false);
    expect(isReviewDay('2026-10-25')).toBe(false);
    expect(isReviewDay('2026-10-26')).toBe(true);
  });
});
