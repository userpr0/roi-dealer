import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvalRequestIdSchema,
  calculateReward,
  changeSourceStatus,
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
  changeHypothesisStatus,
  decisionIdSchema,
  evidenceIdSchema,
  experimentIdSchema,
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
  approveExperiment,
  stopExperiment,
  toTimestamp,
  usd,
  experimentTotalBudget,
  type Source,
} from '@roi-dealer/domain';
import {
  ConcurrencyError,
  ConstraintViolationError,
  DataIntegrityError,
  NotFoundError,
  type Repositories,
} from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  evidenceData,
  experimentData,
  hypothesisData,
  MEMBER,
  OWNER,
  opportunityData,
  painData,
  sourceData,
  SYSTEM,
} from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

let test: TestDatabase;
let repos: Repositories;

beforeAll(async () => {
  test = await createTestDatabase();
  repos = test.database.repositories;
});

afterAll(async () => {
  await test.drop();
});

/** Every entity type, created through domain functions and stored as it is created. */
async function storeChain() {
  const source = createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));
  const secondSource = createSource(
    // No url: optional fields that are absent must stay absent after a round trip.
    { kind: 'review_site', name: 'G2', markets: ['US'], languages: ['en', 'en-GB'], trust: 'high' },
    createCtx(sourceIdSchema, SYSTEM, 0),
  );
  await repos.sources.insert(source);
  await repos.sources.insert(secondSource);

  const evidence = createEvidence(evidenceData(source.id), createCtx(evidenceIdSchema, AGENT, 1));
  const bareEvidence = createEvidence(
    { sourceId: secondSource.id, kind: 'metric', excerpt: '42 reviews', observedAt: at(0) },
    createCtx(evidenceIdSchema, AGENT, 1),
  );
  await repos.evidence.insert(evidence);
  await repos.evidence.insert(bareEvidence);
  const evidenceIds = [bareEvidence.id, evidence.id];

  const signal = createSignal(
    {
      title: 'Reconciliation complaints',
      summary: 'Agencies complain about manual invoice matching',
      evidenceIds,
      markets: ['US', 'GB'],
      strength: 'strong',
    },
    createCtx(signalIdSchema, AGENT, 2),
  );
  await repos.signals.insert(signal);

  const pain = createPain(
    painData(evidenceIds, { signalIds: [signal.id] }),
    createCtx(painIdSchema, AGENT, 3),
  );
  await repos.pains.insert(pain);

  const opportunity = createOpportunity(
    opportunityData([pain.id], {
      valueProposition: {
        problem: 'Hours lost weekly',
        change: 'Automatic matching',
        measurableResult: 'Save 5+ hours per week',
        proof: 'Two design partners',
      },
    }),
    createCtx(opportunityIdSchema, AGENT, 4),
  );
  await repos.opportunities.insert(opportunity);

  const decision = createDecision(
    {
      subject: { type: 'opportunity', id: opportunity.id },
      outcome: 'approve',
      rationale: 'Strong pain across two sources',
      evidenceIds,
    },
    createCtx(decisionIdSchema, OWNER, 5),
  );
  await repos.decisions.insert(decision);

  const hypothesis = createHypothesis(
    hypothesisData(opportunity.id, {
      successMetric: { name: 'conversion', target: 4.75, unit: '%', direction: 'at_least' },
    }),
    createCtx(hypothesisIdSchema, AGENT, 6),
  );
  await repos.hypotheses.insert(hypothesis);
  const selected = changeHypothesisStatus(hypothesis, 'selected', ctx(OWNER, 7));
  await repos.hypotheses.update(selected, OWNER);

  const planned = createExperiment(
    experimentData(opportunity.id, selected.id),
    selected,
    createCtx(experimentIdSchema, AGENT, 8),
  );
  await repos.experiments.insert(planned);

  const launch = createApprovalRequest(
    {
      kind: 'experiment_launch',
      title: 'Launch landing test',
      summary: 'Build and ads budget',
      amount: experimentTotalBudget(planned),
      subject: { type: 'experiment', id: planned.id },
      expiresAt: at(24 * 60),
    },
    createCtx(approvalRequestIdSchema, SYSTEM, 9),
  );
  await repos.approvalRequests.insert(launch);
  const launchApproved = resolveApprovalRequest(
    launch,
    { decision: 'approve', comment: 'Go' },
    ctx(OWNER, 10),
  );
  await repos.approvalRequests.update(launchApproved, OWNER);

  const awaiting = requestExperimentApproval(planned, launch.id, ctx(SYSTEM, 9));
  await repos.experiments.update(awaiting, SYSTEM);
  const approved = approveExperiment(awaiting, launchApproved, ctx(OWNER, 11));
  await repos.experiments.update(approved, OWNER);
  const running = startExperiment(approved, ctx(SYSTEM, 12));
  await repos.experiments.update(running, SYSTEM);

  const cost = recordCostEntry(
    {
      category: 'ai',
      amount: usd(900),
      description: 'Landing copy generation',
      incurredAt: at(13),
      recurring: false,
      allocation: { opportunityId: opportunity.id, experimentId: running.id },
    },
    createCtx(costEntryIdSchema, SYSTEM, 13),
  );
  await repos.costEntries.insert(cost);
  const reversal = recordCostEntry(
    {
      category: 'ai',
      amount: usd(900),
      description: 'Duplicate charge reversed',
      incurredAt: at(14),
      recurring: false,
      allocation: {},
      reversalOf: cost.id,
    },
    createCtx(costEntryIdSchema, SYSTEM, 14),
  );
  await repos.costEntries.insert(reversal);

  const asset = createKnowledgeAsset(
    {
      kind: 'market_data',
      title: 'Landing conversion',
      summary: '6.1% waitlist conversion',
      body: 'Details of the test',
      links: { evidenceIds, opportunityId: opportunity.id, experimentId: running.id },
      tags: ['reconciliation', 'agencies'],
    },
    createCtx(knowledgeAssetIdSchema, AGENT, 20),
  );
  await repos.knowledgeAssets.insert(asset);

  const stopped = stopExperiment(running, 'Minimum data reached', ctx(SYSTEM, 19));
  await repos.experiments.update(stopped, SYSTEM);
  const completed = completeExperiment(
    stopped,
    { outcome: 'scale', summary: 'Conversion above target', assetIds: [asset.id] },
    ctx(OWNER, 21),
  );
  await repos.experiments.update(completed, OWNER);

  const contribution = createContribution(
    {
      contributor: MEMBER,
      kind: 'analysis',
      description: 'Ran the winning hypothesis',
      subject: { type: 'experiment', id: completed.id },
      occurredAt: at(21),
    },
    createCtx(contributionIdSchema, SYSTEM, 22),
  );
  await repos.contributions.insert(contribution);
  const verified = reviewContribution(
    contribution,
    { verdict: 'verify', note: 'Checked' },
    ctx(OWNER, 23),
  );
  await repos.contributions.update(verified, OWNER);

  const reward = calculateReward(
    {
      contributor: MEMBER,
      contributionIds: [verified.id],
      amount: usd(5_000),
      ruleId: 'manual-v1',
    },
    [verified],
    createCtx(rewardIdSchema, SYSTEM, 24),
  );
  await repos.rewards.insert(reward);

  return {
    source,
    secondSource,
    evidence,
    bareEvidence,
    signal,
    pain,
    opportunity,
    decision,
    hypothesis: selected,
    experiment: completed,
    launch: launchApproved,
    cost,
    reversal,
    asset,
    contribution: verified,
    reward,
  };
}

describe('repositories', () => {
  it('store every entity and read it back unchanged', async () => {
    const chain = await storeChain();

    expect(await repos.sources.getById(chain.source.id)).toStrictEqual(chain.source);
    expect(await repos.sources.getById(chain.secondSource.id)).toStrictEqual(chain.secondSource);
    expect(await repos.evidence.getById(chain.evidence.id)).toStrictEqual(chain.evidence);
    expect(await repos.evidence.getById(chain.bareEvidence.id)).toStrictEqual(chain.bareEvidence);
    expect(await repos.signals.getById(chain.signal.id)).toStrictEqual(chain.signal);
    expect(await repos.pains.getById(chain.pain.id)).toStrictEqual(chain.pain);
    expect(await repos.opportunities.getById(chain.opportunity.id)).toStrictEqual(
      chain.opportunity,
    );
    expect(await repos.decisions.getById(chain.decision.id)).toStrictEqual(chain.decision);
    expect(await repos.hypotheses.getById(chain.hypothesis.id)).toStrictEqual(chain.hypothesis);
    expect(await repos.approvalRequests.getById(chain.launch.id)).toStrictEqual(chain.launch);
    expect(await repos.experiments.getById(chain.experiment.id)).toStrictEqual(chain.experiment);
    expect(await repos.costEntries.getById(chain.cost.id)).toStrictEqual(chain.cost);
    expect(await repos.costEntries.getById(chain.reversal.id)).toStrictEqual(chain.reversal);
    expect(await repos.knowledgeAssets.getById(chain.asset.id)).toStrictEqual(chain.asset);
    expect(await repos.contributions.getById(chain.contribution.id)).toStrictEqual(
      chain.contribution,
    );
    expect(await repos.rewards.getById(chain.reward.id)).toStrictEqual(chain.reward);
  });

  it('keep the order of id lists', async () => {
    const chain = await storeChain();
    const signal = await repos.signals.getById(chain.signal.id);
    expect(signal?.evidenceIds).toEqual([chain.bareEvidence.id, chain.evidence.id]);
  });

  it('return found entities in the requested order and skip unknown ids', async () => {
    const chain = await storeChain();
    const unknown = evidenceIdSchema.parse(uuidv7());

    const found = await repos.evidence.getByIds([
      chain.evidence.id,
      unknown,
      chain.bareEvidence.id,
    ]);

    expect(found.map((item) => item.id)).toEqual([chain.evidence.id, chain.bareEvidence.id]);
    await expect(repos.evidence.getById(unknown)).resolves.toBeUndefined();
    await expect(repos.evidence.getByIds([])).resolves.toEqual([]);
  });

  it('store the next version of an entity', async () => {
    const { source } = await storeChain();
    const paused = changeSourceStatus(source, 'paused', ctx(OWNER, 30));

    await repos.sources.update(paused, OWNER);

    const stored = await repos.sources.getById(source.id);
    expect(stored).toStrictEqual(paused);
    expect(stored?.version).toBe(2);
  });

  it('reject an update based on a stale version (optimistic locking)', async () => {
    const { source } = await storeChain();
    await repos.sources.update(changeSourceStatus(source, 'paused', ctx(OWNER, 30)), OWNER);

    const staleChange = changeSourceStatus(source, 'retired', ctx(AGENT, 31));
    const error = await repos.sources.update(staleChange, AGENT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(error).toMatchObject({
      entity: 'source',
      id: source.id,
      expectedVersion: 1,
      actualVersion: 2,
    });
    expect((await repos.sources.getById(source.id))?.status).toBe('paused');
  });

  it('report an update of an entity that was never stored', async () => {
    const source = createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));
    const error = await repos.sources
      .update(changeSourceStatus(source, 'paused', ctx(OWNER, 1)), OWNER)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ entity: 'source', id: source.id });
  });

  it('never rewrite stored id lists', async () => {
    const { signal, evidence } = await storeChain();
    const rewritten = { ...signal, evidenceIds: [evidence.id], version: signal.version + 1 };

    const error = await repos.signals.update(rewritten, AGENT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect(error).toMatchObject({ kind: 'forbidden_change', table: 'signal_evidence' });
    expect((await repos.signals.getById(signal.id))?.version).toBe(1);
  });

  it('keep exact money amounts up to the largest safe integer', async () => {
    const { opportunity } = await storeChain();
    const hypothesis = createHypothesis(
      hypothesisData(opportunity.id, {
        price: usd(0),
        budget: usd(Number.MAX_SAFE_INTEGER),
        stopLoss: usd(Number.MAX_SAFE_INTEGER - 1),
      }),
      createCtx(hypothesisIdSchema, AGENT, 40),
    );
    await repos.hypotheses.insert(hypothesis);

    expect(await repos.hypotheses.getById(hypothesis.id)).toStrictEqual(hypothesis);
  });

  it('store instants in UTC without shifting them', async () => {
    // 01:30 UTC on the night Europe/Kyiv switches to summer time.
    const instant = toTimestamp(new Date('2026-03-29T01:30:00.123Z'));
    const source = createSource(sourceData(), {
      id: sourceIdSchema.parse(uuidv7()),
      actor: OWNER,
      at: instant,
    });
    await repos.sources.insert(source);

    const [raw] = await test.database.sql<{ utc: string }[]>`
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as utc
      from sources where id = ${source.id}
    `;
    expect(raw?.utc).toBe('2026-03-29T01:30:00.123Z');
    expect((await repos.sources.getById(source.id))?.createdAt).toBe(instant);
  });

  it('refuse to return a stored row that breaks the domain schema', async () => {
    const opportunity = createOpportunity(
      opportunityData([painIdSchema.parse(uuidv7())]),
      createCtx(opportunityIdSchema, AGENT, 0),
    );
    // Written around the repository: no pain links, which the domain requires.
    await test.database.sql.begin(async (tx) => {
      await tx`
        insert into opportunities (
          id, title, summary, icp, markets, value_problem, value_change, value_measurable_result,
          business_model, status, created_at, created_by_type, created_by_id, updated_at, version
        ) values (
          ${opportunity.id}, 'Orphan', 'No pains', 'Anyone', ${['US']}, 'p', 'c', 'r',
          'subscription', 'draft', now(), 'agent', 'a', now(), 1
        )
      `;
      await tx`
        insert into events (id, type, aggregate_type, aggregate_id, aggregate_version,
                            occurred_at, actor_type, actor_id, payload)
        values (${uuidv7()}, 'opportunity.created', 'opportunity', ${opportunity.id}, 1,
                now(), 'agent', 'a', ${tx.json({ snapshot: {} })})
      `;
    });

    const error = await repos.opportunities
      .getById(opportunity.id)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataIntegrityError);
    expect(error).toMatchObject({ entity: 'opportunity', id: opportunity.id });
    expect((error as DataIntegrityError).issues.map((issue) => issue.path)).toContain('painIds');
  });
});

describe('database.transaction', () => {
  const newSource = (): Source => createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));

  it('commits every write together', async () => {
    const [first, second] = [newSource(), newSource()];
    await test.database.transaction(async ({ repositories }) => {
      await repositories.sources.insert(first);
      await repositories.sources.insert(second);
    });

    expect(await repos.sources.getByIds([first.id, second.id])).toHaveLength(2);
  });

  it('rolls back every write when the work fails', async () => {
    const source = newSource();
    const failure = new Error('stop');

    await expect(
      test.database.transaction(async ({ repositories }) => {
        await repositories.sources.insert(source);
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(repos.sources.getById(source.id)).resolves.toBeUndefined();
  });

  it('keeps the transaction usable after a rejected write', async () => {
    const source = newSource();
    await test.database.transaction(async ({ repositories }) => {
      await repositories.sources.insert(source);
      await expect(repositories.sources.insert(source)).rejects.toMatchObject({
        kind: 'unique',
        constraint: 'sources_pkey',
      });
      await repositories.sources.update(changeSourceStatus(source, 'paused', ctx(OWNER, 1)), OWNER);
    });

    expect((await repos.sources.getById(source.id))?.status).toBe('paused');
  });
});
