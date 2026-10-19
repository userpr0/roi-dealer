import type { Database } from '@roi-dealer/database';
import {
  applyOpportunityDecision,
  approvalRequestIdSchema,
  approveExperiment,
  changeHypothesisStatus,
  confirmHonestChecks,
  createApprovalRequest,
  createDecision,
  createEvidence,
  createExperiment,
  createHypothesis,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  experimentIdSchema,
  experimentTotalBudget,
  funnelMetric,
  hypothesisIdSchema,
  opportunityIdSchema,
  painIdSchema,
  planExperiment,
  requestExperimentApproval,
  resolveApprovalRequest,
  signalIdSchema,
  sourceIdSchema,
  startExperiment,
  startOpportunityValidation,
  submitOpportunityForReview,
  toTimestamp,
  usd,
  type Experiment,
  type Opportunity,
  type Pain,
  type Timestamp,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { hypothesisData, OWNER, SYSTEM, sourceData } from './domain.js';

/*
 * The cycle as PHASE 05–15 leave it, built through the domain for tests of later phases: an
 * opportunity the owner approved, and a launched test of one of its hypotheses.
 */

const at = (ms: number): Timestamp => toTimestamp(new Date(ms));

/** An opportunity the owner approved (PHASE 12) from one pain with one signal. */
export async function approvedOpportunity(
  db: Database,
  title: string,
  options: { readonly signalAtMs?: number } = {},
): Promise<{ readonly opportunity: Opportunity; readonly pain: Pain }> {
  const now = Date.now();
  const signalAt = at(options.signalAtMs ?? now);
  const forum = createSource(sourceData({ name: `Forum · ${title}` }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: signalAt,
  });
  await db.repositories.sources.insert(forum);
  const evidence = createEvidence(
    { sourceId: forum.id, kind: 'post', excerpt: `${title}: it costs us.`, observedAt: signalAt },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: signalAt },
  );
  await db.repositories.evidence.insert(evidence);
  const signal = createSignal(
    { title, summary: title, evidenceIds: [evidence.id], markets: ['US'], strength: 'moderate' },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: signalAt },
  );
  await db.repositories.signals.insert(signal);
  const pain = createPain(
    {
      title,
      description: title,
      audience: 'Freelancers',
      desiredOutcome: 'Paid on time',
      severity: 3,
      frequency: 'rare',
      markets: ['US'],
      signalIds: [signal.id],
      evidenceIds: [evidence.id],
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: signalAt },
  );
  await db.repositories.pains.insert(pain);
  const draft = createOpportunity(
    {
      title,
      summary: `${title}.`,
      painIds: [pain.id],
      icp: 'Freelancers',
      markets: ['US'],
      valueProposition: {
        problem: 'Clients pay late',
        change: 'Reminders run on their own',
        measurableResult: 'A day a month back',
      },
      businessModel: { model: 'subscription', pricingHypothesis: '$12 a month' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: at(now) },
  );
  await db.repositories.opportunities.insert(draft);
  const review = submitOpportunityForReview(draft, { actor: SYSTEM, at: at(now) });
  await db.repositories.opportunities.update(review, SYSTEM);
  const decision = createDecision(
    {
      subject: { type: 'opportunity', id: review.id },
      outcome: 'approve',
      rationale: 'Approve.',
      evidenceIds: [],
    },
    { id: decisionIdSchema.parse(uuidv7()), actor: OWNER, at: at(now) },
  );
  await db.repositories.decisions.insert(decision);
  const opportunity = applyOpportunityDecision(review, decision);
  await db.repositories.opportunities.update(opportunity, OWNER);
  return { opportunity, pain };
}

/**
 * A landing-page test of the opportunity with a $50 budget, a $20 stop-loss and the metric
 * "leads ≥ 20": checklist confirmed, launch approved, started at `startedAtMs`.
 */
export async function runningTest(
  db: Database,
  opportunity: Opportunity,
  options: { readonly startedAtMs?: number } = {},
): Promise<Experiment> {
  const now = Date.now();
  const startedAt = at(options.startedAtMs ?? now);
  const proposed = createHypothesis(
    hypothesisData(opportunity.id, {
      successMetric: funnelMetric({ stage: 'lead' }, 20),
      budget: usd(5_000),
      stopLoss: usd(2_000),
      channel: 'Reddit ads',
    }),
    { id: hypothesisIdSchema.parse(uuidv7()), actor: SYSTEM, at: startedAt },
  );
  await db.repositories.hypotheses.insert(proposed);
  const selected = changeHypothesisStatus(proposed, 'selected', { actor: OWNER, at: startedAt });
  await db.repositories.hypotheses.update(selected, OWNER);
  const planned = createExperiment(planExperiment(selected), selected, {
    id: experimentIdSchema.parse(uuidv7()),
    actor: OWNER,
    at: startedAt,
  });
  await db.repositories.experiments.insert(planned);
  const checked = confirmHonestChecks(planned, selected, { actor: OWNER, at: startedAt });
  await db.repositories.experiments.update(checked, OWNER);
  const request = createApprovalRequest(
    {
      kind: 'experiment_launch',
      title: 'Launch',
      summary: 'Test budget',
      amount: experimentTotalBudget(checked),
      subject: { type: 'experiment', id: checked.id },
      expiresAt: at(now + 86_400_000),
    },
    { id: approvalRequestIdSchema.parse(uuidv7()), actor: OWNER, at: startedAt },
  );
  await db.repositories.approvalRequests.insert(request);
  const launch = resolveApprovalRequest(
    request,
    { decision: 'approve' },
    { actor: OWNER, at: startedAt },
  );
  await db.repositories.approvalRequests.update(launch, OWNER);
  const awaiting = requestExperimentApproval(checked, request.id, { actor: OWNER, at: startedAt });
  await db.repositories.experiments.update(awaiting, OWNER);
  const ready = approveExperiment(awaiting, launch, { actor: OWNER, at: startedAt });
  await db.repositories.experiments.update(ready, OWNER);
  const started = startExperiment(ready, { actor: OWNER, at: startedAt });
  await db.repositories.experiments.update(started, OWNER);
  await db.repositories.hypotheses.update(
    changeHypothesisStatus(selected, 'testing', { actor: OWNER, at: startedAt }),
    OWNER,
  );
  // As ▶️ in /experiments does (PHASE 15): the first test puts the opportunity under validation.
  const current = await db.repositories.opportunities.getById(opportunity.id);
  if (current?.status === 'approved') {
    await db.repositories.opportunities.update(
      startOpportunityValidation(current, { actor: OWNER, at: at(now) }),
      OWNER,
    );
  }
  return started;
}
