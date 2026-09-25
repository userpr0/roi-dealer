import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyOpportunityDecision,
  approvalRequestIdSchema,
  approveExperiment,
  approveReward,
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
  hypothesisIdSchema,
  knowledgeAssetIdSchema,
  opportunityIdSchema,
  painIdSchema,
  recordCostEntry,
  requestExperimentApproval,
  resolveApprovalRequest,
  reviewContribution,
  rewardIdSchema,
  selectEvidence,
  signalIdSchema,
  sourceIdSchema,
  startExperiment,
  startOpportunityValidation,
  stopExperiment,
  submitOpportunityForReview,
  summarizeCosts,
  usd,
  validatePain,
  assertDistinctHypothesisSet,
} from '@roi-dealer/domain';
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
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
});

afterAll(async () => {
  await test.drop();
});

/**
 * The ROI CORE v0.1 loop (playbook §11) with every step persisted: each step reads what it
 * needs from the database (Retrieval Before Reasoning), applies a domain function and stores
 * the result in one transaction.
 */
describe('ROI CORE v0.1 loop persisted in PostgreSQL', () => {
  it('stores the whole cycle and reads it back without differences', async () => {
    const db = test.database;
    const repos = db.repositories;

    // collect source data → create Evidence from two independent sources
    const { sources, evidence } = await db.transaction(async ({ repositories }) => {
      const created = [
        createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0)),
        createSource(
          sourceData({ kind: 'review_site', name: 'G2', url: 'https://www.g2.com' }),
          createCtx(sourceIdSchema, SYSTEM, 0),
        ),
      ];
      const items = created.map((source) =>
        createEvidence(evidenceData(source.id), createCtx(evidenceIdSchema, AGENT, 1)),
      );
      for (const source of created) await repositories.sources.insert(source);
      for (const item of items) await repositories.evidence.insert(item);
      return { sources: created, evidence: items };
    });
    const evidenceIds = evidence.map((item) => item.id);

    // detect Signal → Pain candidate → validate against evidence loaded from the database
    const newSignal = createSignal(
      {
        title: 'Reconciliation complaints',
        summary: 'Agencies repeatedly complain about manual invoice matching',
        evidenceIds,
        markets: ['US'],
        strength: 'strong',
      },
      createCtx(signalIdSchema, AGENT, 2),
    );
    const triaged = changeSignalStatus(newSignal, 'triaged', ctx(AGENT, 3));
    const signal = changeSignalStatus(triaged, 'promoted', ctx(AGENT, 4));
    await db.transaction(async ({ repositories }) => {
      await repositories.signals.insert(newSignal);
      await repositories.signals.update(triaged, AGENT);
      await repositories.signals.update(signal, AGENT);
    });

    const candidate = createPain(
      painData(evidenceIds, { signalIds: [signal.id] }),
      createCtx(painIdSchema, AGENT, 5),
    );
    await repos.pains.insert(candidate);
    const storedCandidate = (await repos.pains.getById(candidate.id)) ?? expect.unreachable();
    const pain = validatePain(
      storedCandidate,
      await repos.evidence.getByIds(storedCandidate.evidenceIds),
      ctx(AGENT, 6),
    );
    await repos.pains.update(pain, AGENT);

    // Opportunity → owner Decision → approve (decision and new status in one transaction)
    const draft = createOpportunity(
      opportunityData([pain.id]),
      createCtx(opportunityIdSchema, AGENT, 7),
    );
    const opportunity = submitOpportunityForReview(draft, ctx(AGENT, 8));
    await repos.opportunities.insert(draft);
    await repos.opportunities.update(opportunity, AGENT);
    const decision = createDecision(
      {
        subject: { type: 'opportunity', id: opportunity.id },
        outcome: 'approve',
        rationale: 'Strong pain across two independent sources; cheap to test',
        evidenceIds,
      },
      createCtx(decisionIdSchema, OWNER, 9),
    );
    const approvedOpportunity = await db.transaction(
      async ({ repositories }) => {
        const current =
          (await repositories.opportunities.getById(opportunity.id)) ?? expect.unreachable();
        const next = applyOpportunityDecision(current, decision);
        await repositories.decisions.insert(decision);
        await repositories.opportunities.update(next, OWNER);
        return next;
      },
      { correlationId: 'tg-update-1001' },
    );
    expect(approvedOpportunity.status).toBe('approved');

    // five distinct hypotheses; the owner selects one
    const proposals = fiveHypotheses(approvedOpportunity.id);
    assertDistinctHypothesisSet(proposals);
    const hypotheses = proposals.map((item) =>
      createHypothesis(item, createCtx(hypothesisIdSchema, AGENT, 10)),
    );
    await db.transaction(async ({ repositories }) => {
      for (const hypothesis of hypotheses) await repositories.hypotheses.insert(hypothesis);
    });
    const chosen = changeHypothesisStatus(
      hypotheses[0] ?? expect.unreachable(),
      'selected',
      ctx(OWNER, 11),
    );
    await repos.hypotheses.update(chosen, OWNER);

    // Experiment plan → launch approval covering the full budget → running
    const planned = createExperiment(
      experimentData(approvedOpportunity.id, chosen.id),
      chosen,
      createCtx(experimentIdSchema, AGENT, 12),
    );
    const launch = createApprovalRequest(
      {
        kind: 'experiment_launch',
        title: 'Launch test: landing',
        summary: 'Build and test budget',
        amount: experimentTotalBudget(planned),
        subject: { type: 'experiment', id: planned.id },
        expiresAt: at(24 * 60),
      },
      createCtx(approvalRequestIdSchema, SYSTEM, 13),
    );
    const awaiting = requestExperimentApproval(planned, launch.id, ctx(SYSTEM, 13));
    await db.transaction(async ({ repositories }) => {
      await repositories.experiments.insert(planned);
      await repositories.approvalRequests.insert(launch);
      await repositories.experiments.update(awaiting, SYSTEM);
    });

    const launchApproved = resolveApprovalRequest(
      (await repos.approvalRequests.getById(launch.id)) ?? expect.unreachable(),
      { decision: 'approve' },
      ctx(OWNER, 14),
    );
    const approvedExperiment = approveExperiment(awaiting, launchApproved, ctx(OWNER, 15));
    const running = startExperiment(approvedExperiment, ctx(SYSTEM, 16));
    const validating = startOpportunityValidation(approvedOpportunity, ctx(SYSTEM, 16));
    await db.transaction(
      async ({ repositories }) => {
        await repositories.approvalRequests.update(launchApproved, OWNER);
        await repositories.experiments.update(approvedExperiment, OWNER);
      },
      { correlationId: 'tg-update-1002' },
    );
    await db.transaction(async ({ repositories }) => {
      await repositories.experiments.update(running, SYSTEM);
      await repositories.opportunities.update(validating, SYSTEM);
    });

    // costs: a small spend passes; a large one references the owner's approval
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
    const adsRequest = createApprovalRequest(
      {
        kind: 'spend',
        title: 'LinkedIn ads',
        summary: 'Test traffic',
        amount: usd(15_000),
        expiresAt: at(24 * 60),
      },
      createCtx(approvalRequestIdSchema, SYSTEM, 18),
    );
    const adsApproval = resolveApprovalRequest(adsRequest, { decision: 'approve' }, ctx(OWNER, 19));
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
    await db.transaction(async ({ repositories }) => {
      await repositories.costEntries.insert(aiCost);
      await repositories.approvalRequests.insert(adsRequest);
      await repositories.approvalRequests.update(adsApproval, OWNER);
      await repositories.costEntries.insert(adsCost);
    });

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
    const stopped = stopExperiment(running, 'Minimum data reached', ctx(SYSTEM, 29));
    const completed = completeExperiment(
      stopped,
      { outcome: 'scale', summary: 'Conversion above target', assetIds: [learning.id] },
      ctx(OWNER, 31),
    );
    await db.transaction(async ({ repositories }) => {
      await repositories.experiments.update(stopped, SYSTEM);
      await repositories.knowledgeAssets.insert(learning);
      await repositories.experiments.update(completed, OWNER);
    });

    // contribution → verification → reward from contributions loaded from the database
    const contribution = createContribution(
      {
        contributor: OWNER,
        kind: 'analysis',
        description: 'Selected and ran the winning hypothesis',
        subject: { type: 'experiment', id: completed.id },
        occurredAt: at(31),
      },
      createCtx(contributionIdSchema, SYSTEM, 32),
    );
    await repos.contributions.insert(contribution);
    const verified = reviewContribution(contribution, { verdict: 'verify' }, ctx(OWNER, 33));
    await repos.contributions.update(verified, OWNER);
    const reward = calculateReward(
      {
        contributor: OWNER,
        contributionIds: [verified.id],
        amount: usd(5_000),
        ruleId: 'manual-v1',
      },
      await repos.contributions.getByIds([verified.id]),
      createCtx(rewardIdSchema, SYSTEM, 34),
    );
    const payoutRequest = createApprovalRequest(
      {
        kind: 'payout',
        title: 'Reward payout',
        summary: 'Reward for the scaled experiment',
        amount: reward.amount,
        subject: { type: 'reward', id: reward.id },
        expiresAt: at(24 * 60),
      },
      createCtx(approvalRequestIdSchema, SYSTEM, 35),
    );
    const payout = resolveApprovalRequest(payoutRequest, { decision: 'approve' }, ctx(OWNER, 36));
    const approvedReward = approveReward(reward, payout, ctx(OWNER, 37));
    await db.transaction(async ({ repositories }) => {
      await repositories.rewards.insert(reward);
      await repositories.approvalRequests.insert(payoutRequest);
      await repositories.approvalRequests.update(payout, OWNER);
      await repositories.rewards.update(approvedReward, OWNER);
    });

    // everything reads back exactly as the domain produced it
    expect(await repos.sources.getByIds(sources.map((item) => item.id))).toStrictEqual(sources);
    expect(selectEvidence(evidenceIds, await repos.evidence.getByIds(evidenceIds))).toStrictEqual(
      evidence,
    );
    expect(await repos.signals.getById(signal.id)).toStrictEqual(signal);
    expect(await repos.pains.getById(pain.id)).toStrictEqual(pain);
    expect(await repos.opportunities.getById(validating.id)).toStrictEqual(validating);
    expect(await repos.decisions.getById(decision.id)).toStrictEqual(decision);
    expect(await repos.hypotheses.getByIds(hypotheses.map((item) => item.id))).toStrictEqual([
      chosen,
      ...hypotheses.slice(1),
    ]);
    expect(await repos.experiments.getById(completed.id)).toStrictEqual(completed);
    expect(await repos.approvalRequests.getById(launch.id)).toStrictEqual(launchApproved);
    expect(await repos.knowledgeAssets.getById(learning.id)).toStrictEqual(learning);
    expect(await repos.contributions.getById(verified.id)).toStrictEqual(verified);
    expect(await repos.rewards.getById(reward.id)).toStrictEqual(approvedReward);

    // deterministic totals from stored ledger lines (§7.3)
    const ledger = await repos.costEntries.getByIds([aiCost.id, adsCost.id]);
    expect(summarizeCosts(ledger).total).toEqual(usd(15_900));

    // complete Event History (§11: "save complete Event History")
    const signalHistory = await db.events.history({ type: 'signal', id: signal.id });
    expect(signalHistory.map((event) => [event.type, event.aggregateVersion])).toEqual([
      ['signal.created', 1],
      ['signal.updated', 2],
      ['signal.updated', 3],
    ]);
    expect(signalHistory.map((event) => event.payload.snapshot)).toEqual([
      newSignal,
      triaged,
      signal,
    ]);

    const experimentHistory = await db.events.history({ type: 'experiment', id: completed.id });
    expect(
      experimentHistory.map((event) => [
        event.payload.previousStatus,
        event.payload.snapshot['status'],
      ]),
    ).toEqual([
      [undefined, 'planned'],
      ['planned', 'awaiting_approval'],
      ['awaiting_approval', 'approved'],
      ['approved', 'running'],
      ['running', 'stopped'],
      ['stopped', 'completed'],
    ]);
    expect(experimentHistory.at(-1)?.actor).toEqual(OWNER);

    // the owner's decision and the opportunity change share the request's correlation id
    const decisionEvents = (await db.events.list()).filter(
      (event) => event.correlationId === 'tg-update-1001',
    );
    expect(decisionEvents.map((event) => [event.type, event.actor.type])).toEqual([
      ['decision.created', 'owner'],
      ['opportunity.updated', 'owner'],
    ]);

    // one event per stored version of every entity (besides the kill switch of migration 0003)
    const allEvents = (await db.events.list({ limit: 1_000 })).filter(
      (event) => event.aggregate.type !== 'system_control',
    );
    const expectedVersions = [
      ...sources,
      ...evidence,
      signal,
      pain,
      validating,
      decision,
      ...hypotheses.slice(1),
      chosen,
      completed,
      launchApproved,
      adsApproval,
      payout,
      aiCost,
      adsCost,
      learning,
      verified,
      approvedReward,
    ].reduce((total, entity) => total + ('version' in entity ? entity.version : 1), 0);
    expect(allEvents).toHaveLength(expectedVersions);
  });
});
