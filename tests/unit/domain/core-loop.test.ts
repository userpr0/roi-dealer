import { describe, expect, it } from 'vitest';
import {
  applyOpportunityDecision,
  approvalRequestIdSchema,
  approveExperiment,
  approveReward,
  assertDistinctHypothesisSet,
  calculateReward,
  changeHypothesisStatus,
  changeSignalStatus,
  completeExperiment,
  contributionIdSchema,
  costEntryIdSchema,
  createApprovalRequest,
  createContribution,
  createDecision,
  createEvidence,
  createExperiment,
  createHypothesis,
  createKnowledgeAsset,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  experimentIdSchema,
  experimentTotalBudget,
  formatUsd,
  hypothesisIdSchema,
  knowledgeAssetIdSchema,
  opportunityIdSchema,
  painIdSchema,
  recordCostEntry,
  requestExperimentApproval,
  resolveApprovalRequest,
  reviewContribution,
  rewardIdSchema,
  signalIdSchema,
  sourceIdSchema,
  startExperiment,
  startOpportunityValidation,
  stopExperiment,
  submitOpportunityForReview,
  summarizeCosts,
  usd,
  validatePain,
} from '@roi-dealer/domain';
import { approvalDecisionInputSchema, createInputSchemas, parseInput } from '@roi-dealer/schemas';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  evidenceData,
  experimentData,
  fiveHypotheses,
  OWNER,
  opportunityData,
  painData,
  sourceData,
  SYSTEM,
} from '../../support/domain.js';

/** Simulates untrusted JSON coming from an AI agent, the bot or the API. */
const fromOutside = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('ROI CORE v0.1 loop (playbook §11) through the public domain API', () => {
  it('goes from source data to a prepared reward with owner gates on every decision', () => {
    // collect source data → create Evidence (from two independent sources)
    const forum = createSource(
      parseInput(createInputSchemas.source, fromOutside(sourceData())),
      createCtx(sourceIdSchema, SYSTEM, 0),
    );
    const reviews = createSource(
      parseInput(
        createInputSchemas.source,
        fromOutside(sourceData({ kind: 'review_site', name: 'G2', url: 'https://www.g2.com' })),
      ),
      createCtx(sourceIdSchema, SYSTEM, 0),
    );
    const evidence = [forum, reviews].map((source) =>
      createEvidence(
        parseInput(createInputSchemas.evidence, fromOutside(evidenceData(source.id))),
        createCtx(evidenceIdSchema, AGENT, 1),
      ),
    );
    const evidenceIds = evidence.map((item) => item.id);

    // detect Signal → create Pain candidate → validate with evidence from 2 sources
    const signal = changeSignalStatus(
      changeSignalStatus(
        createSignal(
          {
            title: 'Reconciliation complaints',
            summary: 'Agencies repeatedly complain about manual invoice matching',
            evidenceIds,
            markets: ['US'],
            strength: 'strong',
          },
          createCtx(signalIdSchema, AGENT, 2),
        ),
        'triaged',
        ctx(AGENT, 3),
      ),
      'promoted',
      ctx(AGENT, 4),
    );
    const pain = validatePain(
      createPain(
        painData(evidenceIds, { signalIds: [signal.id] }),
        createCtx(painIdSchema, AGENT, 5),
      ),
      evidence,
      ctx(AGENT, 6),
    );

    // create Opportunity → show Owner Decision → Owner APPROVE
    const opportunity = submitOpportunityForReview(
      createOpportunity(opportunityData([pain.id]), createCtx(opportunityIdSchema, AGENT, 7)),
      ctx(AGENT, 8),
    );
    const decision = createDecision(
      {
        subject: { type: 'opportunity', id: opportunity.id },
        outcome: 'approve',
        rationale: 'Strong pain across two independent sources; cheap to test',
        evidenceIds,
      },
      createCtx(decisionIdSchema, OWNER, 9),
    );
    const approvedOpportunity = applyOpportunityDecision(opportunity, decision);
    expect(approvedOpportunity.status).toBe('approved');

    // create 5 Hypotheses (proposed by an agent as raw JSON)
    const proposals = fiveHypotheses(approvedOpportunity.id).map((item) =>
      parseInput(createInputSchemas.hypothesis, fromOutside(item)),
    );
    assertDistinctHypothesisSet(proposals);
    const hypotheses = proposals.map((item) =>
      createHypothesis(item, createCtx(hypothesisIdSchema, AGENT, 10)),
    );
    const chosen = changeHypothesisStatus(
      hypotheses[0] ?? expect.unreachable(),
      'selected',
      ctx(OWNER, 11),
    );

    // create Experiment Plan with MSP artifact and Experiment Build Budget
    const planned = createExperiment(
      experimentData(approvedOpportunity.id, chosen.id),
      chosen,
      createCtx(experimentIdSchema, AGENT, 12),
    );
    const launch = createApprovalRequest(
      {
        kind: 'experiment_launch',
        title: `Launch test: ${planned.artifact}`,
        summary: `Total budget ${formatUsd(experimentTotalBudget(planned))}`,
        amount: experimentTotalBudget(planned),
        subject: { type: 'experiment', id: planned.id },
        expiresAt: at(24 * 60),
      },
      createCtx(approvalRequestIdSchema, SYSTEM, 13),
    );
    const ownerAnswer = parseInput(
      approvalDecisionInputSchema,
      fromOutside({ decision: 'approve' }),
    );
    const launchApproved = resolveApprovalRequest(launch, ownerAnswer, ctx(OWNER, 14));
    const running = startExperiment(
      approveExperiment(
        requestExperimentApproval(planned, launch.id, ctx(SYSTEM, 13)),
        launchApproved,
        ctx(OWNER, 15),
      ),
      ctx(SYSTEM, 16),
    );
    const validating = startOpportunityValidation(approvedOpportunity, ctx(SYSTEM, 16));

    // record Costs (small spend passes; large spend needs approval)
    const aiCost = recordCostEntry(
      {
        category: 'ai',
        amount: usd(900),
        description: 'Landing copy generation',
        incurredAt: at(17),
        recurring: false,
        allocation: { opportunityId: validating.id, experimentId: running.id },
      },
      createCtx(costEntryIdSchema, SYSTEM, 17),
    );
    const adsApproval = resolveApprovalRequest(
      createApprovalRequest(
        {
          kind: 'spend',
          title: 'LinkedIn ads',
          summary: 'Test traffic',
          amount: usd(15_000),
          expiresAt: at(24 * 60),
        },
        createCtx(approvalRequestIdSchema, SYSTEM, 18),
      ),
      { decision: 'approve' },
      ctx(OWNER, 19),
    );
    const adsCost = recordCostEntry(
      {
        category: 'ads',
        amount: usd(15_000),
        description: 'LinkedIn campaign',
        incurredAt: at(20),
        recurring: false,
        allocation: { opportunityId: validating.id, experimentId: running.id },
        approvalRequestId: adsApproval.id,
      },
      createCtx(costEntryIdSchema, SYSTEM, 20),
      adsApproval,
    );
    expect(summarizeCosts([aiCost, adsCost]).total).toEqual(usd(15_900));

    // finish the cycle leaving an asset (§2.9)
    const learning = createKnowledgeAsset(
      {
        kind: 'market_data',
        title: 'Landing conversion for reconciliation offer',
        summary: '6.1% waitlist conversion from LinkedIn at $49/month',
        links: { evidenceIds, opportunityId: validating.id, experimentId: running.id },
        tags: ['reconciliation', 'agencies'],
      },
      createCtx(knowledgeAssetIdSchema, AGENT, 30),
    );
    const completed = completeExperiment(
      stopExperiment(running, 'Minimum data reached', ctx(SYSTEM, 29)),
      { outcome: 'scale', summary: 'Conversion above target', assetIds: [learning.id] },
      ctx(OWNER, 31),
    );
    expect(completed.status).toBe('completed');

    // record Contribution → verify → prepare Reward calculation → payout approval
    const contribution = reviewContribution(
      createContribution(
        {
          contributor: OWNER,
          kind: 'analysis',
          description: 'Selected and ran the winning hypothesis',
          subject: { type: 'experiment', id: completed.id },
          occurredAt: at(31),
        },
        createCtx(contributionIdSchema, SYSTEM, 32),
      ),
      { verdict: 'verify' },
      ctx(OWNER, 33),
    );
    const reward = calculateReward(
      {
        contributor: OWNER,
        contributionIds: [contribution.id],
        amount: usd(5_000),
        ruleId: 'manual-v1',
      },
      [contribution],
      createCtx(rewardIdSchema, SYSTEM, 34),
    );
    const payout = resolveApprovalRequest(
      createApprovalRequest(
        {
          kind: 'payout',
          title: 'Reward payout',
          summary: 'Reward for the scaled experiment',
          amount: reward.amount,
          subject: { type: 'reward', id: reward.id },
          expiresAt: at(24 * 60),
        },
        createCtx(approvalRequestIdSchema, SYSTEM, 35),
      ),
      { decision: 'approve' },
      ctx(OWNER, 36),
    );
    expect(approveReward(reward, payout, ctx(OWNER, 37)).status).toBe('approved');
  });
});
