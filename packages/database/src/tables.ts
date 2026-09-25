import {
  approvalRequestSchema,
  contributionSchema,
  costEntrySchema,
  decisionSchema,
  evidenceSchema,
  experimentSchema,
  hypothesisSchema,
  knowledgeAssetSchema,
  opportunitySchema,
  painSchema,
  rewardSchema,
  signalSchema,
  sourceSchema,
  systemControlSchema,
  type ApprovalRequest,
  type Contribution,
  type CostEntry,
  type Decision,
  type Evidence,
  type Experiment,
  type Hypothesis,
  type KnowledgeAsset,
  type Metric,
  type Opportunity,
  type Pain,
  type Reward,
  type Signal,
  type Source,
  type SystemControl,
} from '@roi-dealer/domain';
import type { Row } from './executor.js';
import type { TableSpec } from './repository.js';
import {
  actor,
  actorColumns,
  cents,
  immutableMetaColumns,
  instant,
  money,
  mutableMetaColumns,
  optionalCents,
  readImmutableMeta,
  readMutableMeta,
  when,
  withoutNulls,
  type Columns,
} from './rows.js';

/*
 * Mapping of the 13 PHASE 01 entities (migration 0001) and SystemControl (migration 0003, 13b)
 * to their tables (database/docs/schema.md).
 * `toColumns` writes every column; `fromRow` rebuilds the domain object for schema validation.
 */

function metricColumns(metric: Metric): Columns {
  return {
    success_metric_name: metric.name,
    success_metric_target: metric.target,
    success_metric_unit: metric.unit,
    success_metric_direction: metric.direction,
  };
}

function readMetric(row: Row): unknown {
  return {
    name: row['success_metric_name'],
    target: row['success_metric_target'],
    unit: row['success_metric_unit'],
    direction: row['success_metric_direction'],
  };
}

function subjectColumns(subject: { readonly type: string; readonly id: string } | undefined) {
  return { subject_type: subject?.type ?? null, subject_id: subject?.id ?? null };
}

function readSubject(row: Row): unknown {
  return when(row['subject_type'], () => ({ type: row['subject_type'], id: row['subject_id'] }));
}

export const sourcesTable: TableSpec<Source> = {
  entity: 'source',
  table: 'sources',
  schema: sourceSchema,
  links: {},
  toColumns: (source) => ({
    id: source.id,
    kind: source.kind,
    name: source.name,
    url: source.url ?? null,
    markets: source.markets,
    languages: source.languages,
    trust: source.trust,
    status: source.status,
    ...mutableMetaColumns(source),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      kind: row['kind'],
      name: row['name'],
      url: row['url'],
      markets: row['markets'],
      languages: row['languages'],
      trust: row['trust'],
      status: row['status'],
      ...readMutableMeta(row),
    }),
};

export const evidenceTable: TableSpec<Evidence> = {
  entity: 'evidence',
  table: 'evidence',
  schema: evidenceSchema,
  links: {},
  toColumns: (evidence) => ({
    id: evidence.id,
    source_id: evidence.sourceId,
    kind: evidence.kind,
    excerpt: evidence.excerpt,
    url: evidence.url ?? null,
    observed_at: evidence.observedAt,
    market: evidence.market ?? null,
    language: evidence.language ?? null,
    ...immutableMetaColumns(evidence),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      sourceId: row['source_id'],
      kind: row['kind'],
      excerpt: row['excerpt'],
      url: row['url'],
      observedAt: instant(row['observed_at']),
      market: row['market'],
      language: row['language'],
      ...readImmutableMeta(row),
    }),
};

export const signalsTable: TableSpec<Signal> = {
  entity: 'signal',
  table: 'signals',
  schema: signalSchema,
  links: {
    evidenceIds: {
      table: 'signal_evidence',
      parentColumn: 'signal_id',
      childColumn: 'evidence_id',
      ids: (signal) => signal.evidenceIds,
    },
  },
  toColumns: (signal) => ({
    id: signal.id,
    title: signal.title,
    summary: signal.summary,
    markets: signal.markets,
    strength: signal.strength,
    status: signal.status,
    ...mutableMetaColumns(signal),
  }),
  fromRow: (row, links) => ({
    id: row['id'],
    title: row['title'],
    summary: row['summary'],
    evidenceIds: links['evidenceIds'],
    markets: row['markets'],
    strength: row['strength'],
    status: row['status'],
    ...readMutableMeta(row),
  }),
};

export const painsTable: TableSpec<Pain> = {
  entity: 'pain',
  table: 'pains',
  schema: painSchema,
  links: {
    signalIds: {
      table: 'pain_signals',
      parentColumn: 'pain_id',
      childColumn: 'signal_id',
      ids: (pain) => pain.signalIds,
    },
    evidenceIds: {
      table: 'pain_evidence',
      parentColumn: 'pain_id',
      childColumn: 'evidence_id',
      ids: (pain) => pain.evidenceIds,
    },
  },
  toColumns: (pain) => ({
    id: pain.id,
    title: pain.title,
    description: pain.description,
    audience: pain.audience,
    desired_outcome: pain.desiredOutcome,
    severity: pain.severity,
    frequency: pain.frequency,
    markets: pain.markets,
    status: pain.status,
    ...mutableMetaColumns(pain),
  }),
  fromRow: (row, links) => ({
    id: row['id'],
    title: row['title'],
    description: row['description'],
    audience: row['audience'],
    desiredOutcome: row['desired_outcome'],
    severity: row['severity'],
    frequency: row['frequency'],
    markets: row['markets'],
    signalIds: links['signalIds'],
    evidenceIds: links['evidenceIds'],
    status: row['status'],
    ...readMutableMeta(row),
  }),
};

export const opportunitiesTable: TableSpec<Opportunity> = {
  entity: 'opportunity',
  table: 'opportunities',
  schema: opportunitySchema,
  links: {
    painIds: {
      table: 'opportunity_pains',
      parentColumn: 'opportunity_id',
      childColumn: 'pain_id',
      ids: (opportunity) => opportunity.painIds,
    },
  },
  toColumns: (opportunity) => ({
    id: opportunity.id,
    title: opportunity.title,
    summary: opportunity.summary,
    icp: opportunity.icp,
    markets: opportunity.markets,
    value_problem: opportunity.valueProposition.problem,
    value_change: opportunity.valueProposition.change,
    value_measurable_result: opportunity.valueProposition.measurableResult,
    value_proof: opportunity.valueProposition.proof ?? null,
    business_model: opportunity.businessModel.model,
    pricing_hypothesis: opportunity.businessModel.pricingHypothesis ?? null,
    parent_id: opportunity.parentId ?? null,
    status: opportunity.status,
    last_decision_id: opportunity.lastDecisionId ?? null,
    ...mutableMetaColumns(opportunity),
  }),
  fromRow: (row, links) =>
    withoutNulls({
      id: row['id'],
      title: row['title'],
      summary: row['summary'],
      painIds: links['painIds'],
      icp: row['icp'],
      markets: row['markets'],
      valueProposition: withoutNulls({
        problem: row['value_problem'],
        change: row['value_change'],
        measurableResult: row['value_measurable_result'],
        proof: row['value_proof'],
      }),
      businessModel: withoutNulls({
        model: row['business_model'],
        pricingHypothesis: row['pricing_hypothesis'],
      }),
      parentId: row['parent_id'],
      status: row['status'],
      lastDecisionId: row['last_decision_id'],
      ...readMutableMeta(row),
    }),
};

export const decisionsTable: TableSpec<Decision> = {
  entity: 'decision',
  table: 'decisions',
  schema: decisionSchema,
  links: {
    evidenceIds: {
      table: 'decision_evidence',
      parentColumn: 'decision_id',
      childColumn: 'evidence_id',
      ids: (decision) => decision.evidenceIds,
    },
  },
  toColumns: (decision) => ({
    id: decision.id,
    subject_type: decision.subject.type,
    subject_id: decision.subject.id,
    outcome: decision.outcome,
    rationale: decision.rationale,
    ...immutableMetaColumns(decision),
  }),
  fromRow: (row, links) => ({
    id: row['id'],
    subject: { type: row['subject_type'], id: row['subject_id'] },
    outcome: row['outcome'],
    rationale: row['rationale'],
    evidenceIds: links['evidenceIds'],
    ...readImmutableMeta(row),
  }),
};

export const approvalRequestsTable: TableSpec<ApprovalRequest> = {
  entity: 'approval_request',
  table: 'approval_requests',
  schema: approvalRequestSchema,
  links: {},
  toColumns: (request) => ({
    id: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    ...subjectColumns(request.subject),
    amount_usd_cents: optionalCents(request.amount),
    expires_at: request.expiresAt,
    status: request.status,
    decided_by_type: request.resolution?.decidedBy.type ?? null,
    decided_by_id: request.resolution?.decidedBy.id ?? null,
    decided_at: request.resolution?.decidedAt ?? null,
    decision_comment: request.resolution?.comment ?? null,
    ...mutableMetaColumns(request),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      kind: row['kind'],
      title: row['title'],
      summary: row['summary'],
      subject: readSubject(row),
      amount: row['amount_usd_cents'] === null ? null : money(row['amount_usd_cents']),
      expiresAt: instant(row['expires_at']),
      status: row['status'],
      resolution: when(row['decided_at'], () => ({
        decidedBy: actor(row['decided_by_type'], row['decided_by_id']),
        decidedAt: instant(row['decided_at']),
        comment: row['decision_comment'],
      })),
      ...readMutableMeta(row),
    }),
};

export const hypothesesTable: TableSpec<Hypothesis> = {
  entity: 'hypothesis',
  table: 'hypotheses',
  schema: hypothesisSchema,
  links: {},
  toColumns: (hypothesis) => ({
    id: hypothesis.id,
    opportunity_id: hypothesis.opportunityId,
    statement: hypothesis.statement,
    audience: hypothesis.audience,
    geo: hypothesis.geo,
    offer: hypothesis.offer,
    price_usd_cents: cents(hypothesis.price),
    channel: hypothesis.channel,
    creative: hypothesis.creative,
    cta: hypothesis.cta,
    validation_method: hypothesis.validationMethod,
    ...metricColumns(hypothesis.successMetric),
    budget_usd_cents: cents(hypothesis.budget),
    stop_loss_usd_cents: cents(hypothesis.stopLoss),
    minimum_data: hypothesis.minimumData,
    parent_id: hypothesis.parentId ?? null,
    status: hypothesis.status,
    ...mutableMetaColumns(hypothesis),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      opportunityId: row['opportunity_id'],
      statement: row['statement'],
      audience: row['audience'],
      geo: row['geo'],
      offer: row['offer'],
      price: money(row['price_usd_cents']),
      channel: row['channel'],
      creative: row['creative'],
      cta: row['cta'],
      validationMethod: row['validation_method'],
      successMetric: readMetric(row),
      budget: money(row['budget_usd_cents']),
      stopLoss: money(row['stop_loss_usd_cents']),
      minimumData: row['minimum_data'],
      parentId: row['parent_id'],
      status: row['status'],
      ...readMutableMeta(row),
    }),
};

export const experimentsTable: TableSpec<Experiment> = {
  entity: 'experiment',
  table: 'experiments',
  schema: experimentSchema,
  links: {
    resultAssetIds: {
      table: 'experiment_result_assets',
      parentColumn: 'experiment_id',
      childColumn: 'knowledge_asset_id',
      ids: (experiment) => experiment.result?.assetIds ?? [],
    },
  },
  toColumns: (experiment) => ({
    id: experiment.id,
    opportunity_id: experiment.opportunityId,
    hypothesis_id: experiment.hypothesisId,
    artifact: experiment.artifact,
    description: experiment.description,
    build_max_money_usd_cents: cents(experiment.buildBudget.maxMoney),
    build_max_ai_cost_usd_cents: cents(experiment.buildBudget.maxAiCost),
    build_max_human_hours: experiment.buildBudget.maxHumanHours,
    build_max_calendar_days: experiment.buildBudget.maxCalendarDays,
    test_budget_usd_cents: cents(experiment.testBudget),
    stop_loss_usd_cents: cents(experiment.stopLoss),
    ...metricColumns(experiment.successMetric),
    kill_criteria: experiment.killCriteria,
    expected_evidence: experiment.expectedEvidence,
    status: experiment.status,
    approval_request_id: experiment.approvalRequestId ?? null,
    started_at: experiment.startedAt ?? null,
    ended_at: experiment.endedAt ?? null,
    stop_reason: experiment.stopReason ?? null,
    result_outcome: experiment.result?.outcome ?? null,
    result_summary: experiment.result?.summary ?? null,
    ...mutableMetaColumns(experiment),
  }),
  fromRow: (row, links) =>
    withoutNulls({
      id: row['id'],
      opportunityId: row['opportunity_id'],
      hypothesisId: row['hypothesis_id'],
      artifact: row['artifact'],
      description: row['description'],
      buildBudget: {
        maxMoney: money(row['build_max_money_usd_cents']),
        maxAiCost: money(row['build_max_ai_cost_usd_cents']),
        maxHumanHours: row['build_max_human_hours'],
        maxCalendarDays: row['build_max_calendar_days'],
      },
      testBudget: money(row['test_budget_usd_cents']),
      stopLoss: money(row['stop_loss_usd_cents']),
      successMetric: readMetric(row),
      killCriteria: row['kill_criteria'],
      expectedEvidence: row['expected_evidence'],
      status: row['status'],
      approvalRequestId: row['approval_request_id'],
      startedAt: instant(row['started_at']),
      endedAt: instant(row['ended_at']),
      stopReason: row['stop_reason'],
      result: when(row['result_outcome'], () => ({
        outcome: row['result_outcome'],
        summary: row['result_summary'],
        assetIds: links['resultAssetIds'],
      })),
      ...readMutableMeta(row),
    }),
};

export const costEntriesTable: TableSpec<CostEntry> = {
  entity: 'cost_entry',
  table: 'cost_entries',
  schema: costEntrySchema,
  links: {},
  toColumns: (entry) => ({
    id: entry.id,
    category: entry.category,
    amount_usd_cents: cents(entry.amount),
    description: entry.description,
    incurred_at: entry.incurredAt,
    recurring: entry.recurring,
    opportunity_id: entry.allocation.opportunityId ?? null,
    hypothesis_id: entry.allocation.hypothesisId ?? null,
    experiment_id: entry.allocation.experimentId ?? null,
    approval_request_id: entry.approvalRequestId ?? null,
    reversal_of: entry.reversalOf ?? null,
    ...immutableMetaColumns(entry),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      category: row['category'],
      amount: money(row['amount_usd_cents']),
      description: row['description'],
      incurredAt: instant(row['incurred_at']),
      recurring: row['recurring'],
      allocation: withoutNulls({
        opportunityId: row['opportunity_id'],
        hypothesisId: row['hypothesis_id'],
        experimentId: row['experiment_id'],
      }),
      approvalRequestId: row['approval_request_id'],
      reversalOf: row['reversal_of'],
      ...readImmutableMeta(row),
    }),
};

export const contributionsTable: TableSpec<Contribution> = {
  entity: 'contribution',
  table: 'contributions',
  schema: contributionSchema,
  links: {},
  toColumns: (contribution) => ({
    id: contribution.id,
    ...actorColumns('contributor', contribution.contributor),
    kind: contribution.kind,
    description: contribution.description,
    ...subjectColumns(contribution.subject),
    occurred_at: contribution.occurredAt,
    status: contribution.status,
    reviewed_by_type: contribution.review?.reviewedBy.type ?? null,
    reviewed_by_id: contribution.review?.reviewedBy.id ?? null,
    reviewed_at: contribution.review?.reviewedAt ?? null,
    review_note: contribution.review?.note ?? null,
    ...mutableMetaColumns(contribution),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      contributor: actor(row['contributor_type'], row['contributor_id']),
      kind: row['kind'],
      description: row['description'],
      subject: readSubject(row),
      occurredAt: instant(row['occurred_at']),
      status: row['status'],
      review: when(row['reviewed_at'], () => ({
        reviewedBy: actor(row['reviewed_by_type'], row['reviewed_by_id']),
        reviewedAt: instant(row['reviewed_at']),
        note: row['review_note'],
      })),
      ...readMutableMeta(row),
    }),
};

export const rewardsTable: TableSpec<Reward> = {
  entity: 'reward',
  table: 'rewards',
  schema: rewardSchema,
  links: {
    contributionIds: {
      table: 'reward_contributions',
      parentColumn: 'reward_id',
      childColumn: 'contribution_id',
      ids: (reward) => reward.contributionIds,
    },
  },
  toColumns: (reward) => ({
    id: reward.id,
    ...actorColumns('contributor', reward.contributor),
    amount_usd_cents: cents(reward.amount),
    rule_id: reward.ruleId,
    note: reward.note ?? null,
    status: reward.status,
    approval_request_id: reward.approvalRequestId ?? null,
    paid_at: reward.payment?.paidAt ?? null,
    payment_reference: reward.payment?.reference ?? null,
    ...mutableMetaColumns(reward),
  }),
  fromRow: (row, links) =>
    withoutNulls({
      id: row['id'],
      contributor: actor(row['contributor_type'], row['contributor_id']),
      contributionIds: links['contributionIds'],
      amount: money(row['amount_usd_cents']),
      ruleId: row['rule_id'],
      note: row['note'],
      status: row['status'],
      approvalRequestId: row['approval_request_id'],
      payment: when(row['paid_at'], () => ({
        paidAt: instant(row['paid_at']),
        reference: row['payment_reference'],
      })),
      ...readMutableMeta(row),
    }),
};

export const knowledgeAssetsTable: TableSpec<KnowledgeAsset> = {
  entity: 'knowledge_asset',
  table: 'knowledge_assets',
  schema: knowledgeAssetSchema,
  links: {
    evidenceIds: {
      table: 'knowledge_asset_evidence',
      parentColumn: 'knowledge_asset_id',
      childColumn: 'evidence_id',
      ids: (asset) => asset.links.evidenceIds,
    },
  },
  toColumns: (asset) => ({
    id: asset.id,
    kind: asset.kind,
    title: asset.title,
    summary: asset.summary,
    body: asset.body ?? null,
    opportunity_id: asset.links.opportunityId ?? null,
    hypothesis_id: asset.links.hypothesisId ?? null,
    experiment_id: asset.links.experimentId ?? null,
    tags: asset.tags,
    supersedes: asset.supersedes ?? null,
    ...immutableMetaColumns(asset),
  }),
  fromRow: (row, links) =>
    withoutNulls({
      id: row['id'],
      kind: row['kind'],
      title: row['title'],
      summary: row['summary'],
      body: row['body'],
      links: withoutNulls({
        evidenceIds: links['evidenceIds'],
        opportunityId: row['opportunity_id'],
        hypothesisId: row['hypothesis_id'],
        experimentId: row['experiment_id'],
      }),
      tags: row['tags'],
      supersedes: row['supersedes'],
      ...readImmutableMeta(row),
    }),
};

export const systemControlsTable: TableSpec<SystemControl> = {
  entity: 'system_control',
  table: 'system_controls',
  schema: systemControlSchema,
  links: {},
  toColumns: (control) => ({
    id: control.id,
    key: control.key,
    status: control.status,
    reason: control.reason ?? null,
    ...mutableMetaColumns(control),
  }),
  fromRow: (row) =>
    withoutNulls({
      id: row['id'],
      key: row['key'],
      status: row['status'],
      reason: row['reason'],
      ...readMutableMeta(row),
    }),
};
