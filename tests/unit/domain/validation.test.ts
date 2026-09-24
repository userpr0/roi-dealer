import { describe, expect, it } from 'vitest';
import {
  approvalRequestIdSchema,
  approveExperiment,
  assertDistinctHypothesisSet,
  cancelExperiment,
  changeHypothesisStatus,
  completeExperiment,
  createApprovalRequest,
  createExperiment,
  createHypothesis,
  experimentIdSchema,
  experimentTotalBudget,
  hypothesisIdSchema,
  knowledgeAssetIdSchema,
  opportunityIdSchema,
  requestExperimentApproval,
  resolveApprovalRequest,
  returnExperimentToPlanning,
  startExperiment,
  stopExperiment,
  usd,
  type Experiment,
  type Hypothesis,
} from '@roi-dealer/domain';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  experimentData,
  fiveHypotheses,
  hypothesisData,
  OWNER,
  SYSTEM,
} from '../../support/domain.js';

const opportunityId = opportunityIdSchema.parse('0190c5a6-7b8e-7c3d-9f00-123456789abc');
const assetId = knowledgeAssetIdSchema.parse('0190c5a6-7b8e-7c3d-9f00-00000000a55e');

function selectedHypothesis(): Hypothesis {
  const proposed = createHypothesis(
    hypothesisData(opportunityId),
    createCtx(hypothesisIdSchema, AGENT),
  );
  return changeHypothesisStatus(proposed, 'selected', ctx(OWNER, 1));
}

function plannedExperiment(): Experiment {
  const hypothesis = selectedHypothesis();
  return createExperiment(
    experimentData(opportunityId, hypothesis.id),
    hypothesis,
    createCtx(experimentIdSchema, AGENT, 2),
  );
}

function launchApproval(
  experiment: Experiment,
  amountCents = experimentTotalBudget(experiment).amountCents,
) {
  const request = createApprovalRequest(
    {
      kind: 'experiment_launch',
      title: 'Launch landing test',
      summary: 'Build and test budget',
      amount: usd(amountCents),
      subject: { type: 'experiment', id: experiment.id },
      expiresAt: at(600),
    },
    createCtx(approvalRequestIdSchema, SYSTEM, 3),
  );
  return resolveApprovalRequest(request, { decision: 'approve' }, ctx(OWNER, 4));
}

describe('Hypothesis', () => {
  it('keeps the stop-loss within the budget', () => {
    expect(() =>
      createHypothesis(
        hypothesisData(opportunityId, { stopLoss: usd(30_000) }),
        createCtx(hypothesisIdSchema),
      ),
    ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));
  });

  it('moves proposed → selected → testing → confirmed', () => {
    const testing = changeHypothesisStatus(selectedHypothesis(), 'testing', ctx(SYSTEM, 5));
    expect(changeHypothesisStatus(testing, 'confirmed', ctx(SYSTEM, 6)).status).toBe('confirmed');
    expect(() => changeHypothesisStatus(testing, 'selected', ctx())).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});

describe('Five Hypothesis rule', () => {
  it('accepts five distinct hypotheses for one opportunity', () => {
    expect(() => assertDistinctHypothesisSet(fiveHypotheses(opportunityId))).not.toThrow();
  });

  it('requires exactly five', () => {
    expect(() => assertDistinctHypothesisSet(fiveHypotheses(opportunityId).slice(0, 4))).toThrow(
      expect.objectContaining({ code: 'invariant_violation', details: { found: 4 } }),
    );
  });

  it('rejects copies that differ only in wording case or spacing', () => {
    const set = fiveHypotheses(opportunityId);
    set[4] = hypothesisData(opportunityId, {
      audience: '  AGENCY owners   in the us ',
      statement: 'Same test, different words',
      creative: 'Another video',
    });
    expect(() => assertDistinctHypothesisSet(set)).toThrow(
      expect.objectContaining({ details: { duplicate_indexes: [4] } }),
    );
  });

  it('rejects hypotheses of different opportunities', () => {
    const set = fiveHypotheses(opportunityId);
    set[0] = hypothesisData(opportunityIdSchema.parse(crypto.randomUUID()));
    expect(() => assertDistinctHypothesisSet(set)).toThrow(/same opportunity/);
  });
});

describe('Experiment', () => {
  it('can only test a selected hypothesis of the same opportunity', () => {
    const proposed = createHypothesis(hypothesisData(opportunityId), createCtx(hypothesisIdSchema));
    expect(() =>
      createExperiment(
        experimentData(opportunityId, proposed.id),
        proposed,
        createCtx(experimentIdSchema),
      ),
    ).toThrow(/selected hypothesis/);

    const selected = selectedHypothesis();
    const otherOpportunity = opportunityIdSchema.parse(crypto.randomUUID());
    expect(() =>
      createExperiment(
        experimentData(otherOpportunity, selected.id),
        selected,
        createCtx(experimentIdSchema),
      ),
    ).toThrow(/match its hypothesis/);
  });

  it('adds build money, AI cost and test budget into the total budget', () => {
    expect(experimentTotalBudget(plannedExperiment())).toEqual(usd(5_000 + 1_000 + 20_000));
  });

  it('runs only after the owner approves a launch request covering the total budget', () => {
    const planned = plannedExperiment();
    expect(() => startExperiment(planned, ctx(SYSTEM, 3))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );

    const approval = launchApproval(planned);
    const awaiting = requestExperimentApproval(planned, approval.id, ctx(SYSTEM, 3));

    expect(() => approveExperiment(awaiting, approval, ctx(AGENT, 5))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
    expect(() => approveExperiment(awaiting, launchApproval(planned, 100), ctx(OWNER, 5))).toThrow(
      expect.objectContaining({ code: 'approval_required' }),
    );

    const approved = approveExperiment(awaiting, approval, ctx(OWNER, 5));
    const running = startExperiment(approved, ctx(SYSTEM, 6));
    expect(running).toMatchObject({
      status: 'running',
      startedAt: at(6),
      approvalRequestId: approval.id,
    });
  });

  it('returns to planning after a rejected launch and can be cancelled', () => {
    const planned = plannedExperiment();
    const awaiting = requestExperimentApproval(planned, launchApproval(planned).id, ctx(SYSTEM, 3));
    expect(returnExperimentToPlanning(awaiting, ctx(SYSTEM, 4)).status).toBe('planned');
    expect(cancelExperiment(awaiting, ctx(OWNER, 4)).status).toBe('cancelled');
  });

  it('completes only with a result that leaves at least one asset', () => {
    const planned = plannedExperiment();
    const approval = launchApproval(planned);
    const running = startExperiment(
      approveExperiment(
        requestExperimentApproval(planned, approval.id, ctx(SYSTEM, 3)),
        approval,
        ctx(OWNER, 5),
      ),
      ctx(SYSTEM, 6),
    );

    const stopped = stopExperiment(running, 'Stop-loss reached', ctx(SYSTEM, 60));
    expect(stopped).toMatchObject({
      status: 'stopped',
      endedAt: at(60),
      stopReason: 'Stop-loss reached',
    });

    expect(() =>
      completeExperiment(
        stopped,
        { outcome: 'kill', summary: 'No demand', assetIds: [] },
        ctx(OWNER, 61),
      ),
    ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));

    const completed = completeExperiment(
      stopped,
      { outcome: 'kill', summary: 'No demand at this price', assetIds: [assetId] },
      ctx(OWNER, 61),
    );
    expect(completed).toMatchObject({
      status: 'completed',
      endedAt: at(60),
      result: { outcome: 'kill', assetIds: [assetId] },
    });
  });
});
