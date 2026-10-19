import { z } from 'zod';
import {
  assertOwner,
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import { readFunnelMeasure } from '../funnel.js';
import {
  compareMoney,
  formatUsd,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  sumMoney,
  ZERO_USD,
  type Money,
} from '../money.js';
import {
  approvalRequestIdSchema,
  experimentIdSchema,
  hypothesisIdSchema,
  knowledgeAssetIdSchema,
  metricSchema,
  opportunityIdSchema,
  text,
  timestampSchema,
  uniqueList,
  type ApprovalRequestId,
  type ExperimentId,
  type Timestamp,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import { assertApprovalCovers, type ApprovalRequest } from './approval.js';
import type { Hypothesis, HypothesisStatus } from './hypothesis.js';

/** The smallest testable product (§7.1 Step C). */
export const MSP_ARTIFACTS = [
  'demo',
  'landing',
  'clickable_prototype',
  'single_function_app',
  'concierge',
  'minimal_automation',
  'other',
] as const;

/** The four decisions after a test (§7.1 Step H). */
export const EXPERIMENT_OUTCOMES = ['scale', 'improve', 'pivot', 'kill'] as const;

export const EXPERIMENT_STATUSES = [
  'planned',
  'awaiting_approval',
  'approved',
  'running',
  'stopped',
  'completed',
  'cancelled',
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const experimentLifecycle = defineStateMachine<ExperimentStatus>('experiment', {
  planned: ['awaiting_approval', 'cancelled'],
  awaiting_approval: ['approved', 'planned', 'cancelled'],
  approved: ['running', 'cancelled'],
  running: ['stopped', 'completed'],
  stopped: ['completed'],
  completed: [],
  cancelled: [],
});

/**
 * The honest-test checklist and the applicable Release Gate items (D-014 п.8, §7.2, PHASE 15):
 * the owner confirms them before the launch request; without them nothing starts.
 */
export const HONEST_CHECKS = [
  /** No invented reviews, numbers or results; the promised result is backed (§2.17). */
  'no_fabrication',
  /** The platform's and channel's rules: banned categories, page requirements, wording. */
  'channel_rules',
  /** The funnel numbers can be read (UTM, platform counters) and reported. */
  'funnel_tracking',
  /** A page of a product that does not exist yet says "coming soon" or "waitlist". */
  'fake_door_disclosed',
  /** The page has a privacy policy, terms, mailing consent (CAN-SPAM, GDPR) and a contact. */
  'page_legal',
  /** Direct messages: a real sender, a way to opt out, no bought lists. */
  'outreach_rules',
  /** Before payment: delivery date, terms and a simple refund; no product — money back. */
  'refund_terms',
  /** Payment and refund tried with a test payment. */
  'payment_tested',
  /** Two or three people went through the demo or prototype unaided (§2.16). */
  'crash_test',
] as const;
export type HonestCheck = (typeof HONEST_CHECKS)[number];

const FAKE_DOOR_METHODS: ReadonlySet<string> = new Set([
  'landing_page',
  'waitlist',
  'ads_test',
  'marketplace_listing',
]);
const PAGE_METHODS: ReadonlySet<string> = new Set([
  'landing_page',
  'waitlist',
  'preorder',
  'ads_test',
]);
const PAID_METHODS: ReadonlySet<string> = new Set(['preorder', 'concierge', 'marketplace_listing']);
const PROTOTYPE_METHODS: ReadonlySet<string> = new Set(['demo', 'clickable_prototype']);

/** The checks that apply to a test of this hypothesis, in a fixed order. */
export function honestChecklist(
  hypothesis: Pick<Hypothesis, 'validationMethod' | 'price'>,
): HonestCheck[] {
  const method = hypothesis.validationMethod;
  const paid = hypothesis.price.amountCents > 0;
  const applies: Readonly<Record<HonestCheck, boolean>> = {
    no_fabrication: true,
    channel_rules: true,
    funnel_tracking: true,
    fake_door_disclosed: FAKE_DOOR_METHODS.has(method),
    page_legal: PAGE_METHODS.has(method),
    outreach_rules: method === 'outreach',
    refund_terms: paid && PAID_METHODS.has(method),
    payment_tested: paid && method === 'preorder',
    crash_test: PROTOTYPE_METHODS.has(method),
  };
  return HONEST_CHECKS.filter((check) => applies[check]);
}

/** Experiment Build Budget, fixed before building (§7.1 Step D). */
export const buildBudgetSchema = z.strictObject({
  maxMoney: nonNegativeMoneySchema,
  maxAiCost: nonNegativeMoneySchema,
  maxHumanHours: z.number().min(0).max(10_000),
  maxCalendarDays: z.int().min(1).max(365),
});

/** Every cycle leaves an asset (§2.9): a result must link at least one knowledge asset. */
export const experimentResultSchema = z.strictObject({
  outcome: z.enum(EXPERIMENT_OUTCOMES),
  summary: text(3_000),
  assetIds: uniqueList(knowledgeAssetIdSchema, { min: 1, max: 50 }),
});
export type ExperimentResult = z.infer<typeof experimentResultSchema>;

const newExperimentShape = {
  opportunityId: opportunityIdSchema,
  hypothesisId: hypothesisIdSchema,
  artifact: z.enum(MSP_ARTIFACTS),
  description: text(3_000),
  buildBudget: buildBudgetSchema,
  testBudget: positiveMoneySchema,
  stopLoss: positiveMoneySchema,
  successMetric: metricSchema,
  killCriteria: text(1_000),
  expectedEvidence: text(1_000),
};

function stopLossWithinBudget(value: { testBudget: Money; stopLoss: Money }): boolean {
  return compareMoney(value.stopLoss, value.testBudget) <= 0;
}
const STOP_LOSS_RULE = { message: 'stopLoss must not exceed testBudget', path: ['stopLoss'] };

export const newExperimentSchema = z
  .strictObject(newExperimentShape)
  .refine(stopLossWithinBudget, STOP_LOSS_RULE);
export type NewExperiment = z.infer<typeof newExperimentSchema>;

export const experimentSchema = z
  .object({
    ...newExperimentShape,
    id: experimentIdSchema,
    status: z.enum(EXPERIMENT_STATUSES),
    /** The honest-test checks the owner confirmed (PHASE 15); empty until then. */
    honestChecks: uniqueList(z.enum(HONEST_CHECKS), { max: HONEST_CHECKS.length }),
    checksConfirmedAt: timestampSchema.optional(),
    approvalRequestId: approvalRequestIdSchema.optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    stopReason: text(500).optional(),
    result: experimentResultSchema.optional(),
    ...mutableMetaShape,
  })
  .refine(stopLossWithinBudget, STOP_LOSS_RULE)
  .refine(
    (experiment) =>
      (experiment.checksConfirmedAt === undefined) === (experiment.honestChecks.length === 0),
    { message: 'confirmed checks need their time', path: ['checksConfirmedAt'] },
  )
  .refine(
    (experiment) =>
      !['running', 'stopped', 'completed'].includes(experiment.status) ||
      experiment.checksConfirmedAt !== undefined,
    { message: 'an experiment starts only after the honest-test checklist', path: ['status'] },
  )
  .refine((experiment) => experiment.status !== 'completed' || experiment.result !== undefined, {
    message: 'a completed experiment must have a result',
    path: ['result'],
  });
export type Experiment = z.infer<typeof experimentSchema>;

/** Everything the experiment may spend: build money, AI cost and test budget. */
export function experimentTotalBudget(experiment: NewExperiment): Money {
  return sumMoney([
    experiment.buildBudget.maxMoney,
    experiment.buildBudget.maxAiCost,
    experiment.testBudget,
  ]);
}

/** Plans an experiment for a hypothesis that was selected for testing. */
export function createExperiment(
  data: NewExperiment,
  hypothesis: Hypothesis,
  context: CreateContext<ExperimentId>,
): Experiment {
  if (hypothesis.id !== data.hypothesisId || hypothesis.opportunityId !== data.opportunityId) {
    throw new DomainError('invariant_violation', 'Experiment must match its hypothesis', {
      hypothesis_id: hypothesis.id,
    });
  }
  if (hypothesis.status !== 'selected') {
    throw new DomainError('invariant_violation', 'Only a selected hypothesis can be tested', {
      hypothesis_status: hypothesis.status,
    });
  }
  return parseEntity(experimentSchema, 'experiment', {
    ...data,
    id: context.id,
    status: 'planned',
    honestChecks: [],
    ...mutableMeta(context),
  });
}

/** How long a test runs at most (§7.1 Step D, PHASE 15). */
export const EXPERIMENT_CALENDAR_DAYS = 14;

/** The smallest product that tests each method (§7.1 Step C, §2.14). */
const ARTIFACT_BY_METHOD: Readonly<
  Record<Hypothesis['validationMethod'], NewExperiment['artifact']>
> = {
  landing_page: 'landing',
  waitlist: 'landing',
  preorder: 'landing',
  ads_test: 'landing',
  demo: 'demo',
  clickable_prototype: 'clickable_prototype',
  concierge: 'concierge',
  outreach: 'other',
  interviews: 'other',
  marketplace_listing: 'other',
  other: 'other',
};
const HUMAN_HOURS: Readonly<Record<NewExperiment['artifact'], number>> = {
  landing: 4,
  demo: 8,
  clickable_prototype: 8,
  single_function_app: 10,
  concierge: 10,
  minimal_automation: 8,
  other: 4,
};

function clip(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The plan of a test of the hypothesis, decided in code (§7.1 C–D, PHASE 15): the smallest
 * artifact for its method, no money and no AI for building at Level 2, the hypothesis's budget,
 * stop-loss and funnel metric, and kill criteria from them.
 */
export function planExperiment(hypothesis: Hypothesis): NewExperiment {
  const measure = readFunnelMeasure(hypothesis.successMetric);
  if (measure === undefined) {
    throw new DomainError('invariant_violation', 'The success metric is not a funnel measure', {
      hypothesis_id: hypothesis.id,
    });
  }
  const artifact = ARTIFACT_BY_METHOD[hypothesis.validationMethod];
  const metric = hypothesis.successMetric;
  return newExperimentSchema.parse({
    opportunityId: hypothesis.opportunityId,
    hypothesisId: hypothesis.id,
    artifact,
    description: clip(
      `${hypothesis.statement} Offer: ${hypothesis.offer}. Channel: ${hypothesis.channel}. ` +
        `CTA: ${hypothesis.cta}.`,
      3_000,
    ),
    buildBudget: {
      maxMoney: ZERO_USD,
      maxAiCost: ZERO_USD,
      maxHumanHours: HUMAN_HOURS[artifact],
      maxCalendarDays: EXPERIMENT_CALENDAR_DAYS,
    },
    testBudget: hypothesis.budget,
    stopLoss: hypothesis.stopLoss,
    successMetric: metric,
    killCriteria: clip(
      `Stop when ${formatUsd(hypothesis.stopLoss)} is spent and ${metric.name} is below ` +
        `${String(metric.target)}${metric.unit === 'count' ? '' : ` ${metric.unit}`}, when ` +
        `${formatUsd(hypothesis.budget)} is spent, or after ${String(EXPERIMENT_CALENDAR_DAYS)} days.`,
      1_000,
    ),
    expectedEvidence: clip(
      `Funnel events up to ${measure.stage}; minimum data: ${hypothesis.minimumData}`,
      1_000,
    ),
  });
}

/**
 * The owner confirms every honest-test check that applies to the hypothesis (D-014 п.8): they are
 * stored with the time; the experiment cannot start without them.
 */
export function confirmHonestChecks(
  experiment: Experiment,
  hypothesis: Hypothesis,
  context: DomainContext,
): Experiment {
  assertOwner(context.actor, 'confirm the honest-test checklist');
  if (hypothesis.id !== experiment.hypothesisId) {
    throw new DomainError('invariant_violation', 'The checklist is for a different hypothesis', {
      experiment_id: experiment.id,
    });
  }
  if (experiment.status !== 'planned') {
    throw new DomainError('invalid_transition', 'The checklist is confirmed while planning', {
      experiment_status: experiment.status,
    });
  }
  return parseEntity(experimentSchema, 'experiment', {
    ...experiment,
    honestChecks: honestChecklist(hypothesis),
    checksConfirmedAt: context.at,
    updatedAt: context.at,
    version: experiment.version + 1,
  });
}

export function requestExperimentApproval(
  experiment: Experiment,
  approvalRequestId: ApprovalRequestId,
  context: DomainContext,
): Experiment {
  return transition(
    experiment,
    experimentLifecycle,
    experimentSchema,
    'awaiting_approval',
    context,
    {
      approvalRequestId,
    },
  );
}

/** Back to planning, e.g. after the owner rejected the launch. */
export function returnExperimentToPlanning(
  experiment: Experiment,
  context: DomainContext,
): Experiment {
  return transition(experiment, experimentLifecycle, experimentSchema, 'planned', context);
}

/**
 * Launch approval: the owner, with an approved `experiment_launch` request
 * for this experiment that covers its total budget.
 */
export function approveExperiment(
  experiment: Experiment,
  approval: ApprovalRequest | undefined,
  context: DomainContext,
): Experiment {
  assertOwner(context.actor, 'approve experiments');
  assertApprovalCovers(approval, {
    ...(experiment.approvalRequestId === undefined ? {} : { id: experiment.approvalRequestId }),
    kind: 'experiment_launch',
    amount: experimentTotalBudget(experiment),
    subject: { type: 'experiment', id: experiment.id },
  });
  return transition(experiment, experimentLifecycle, experimentSchema, 'approved', context);
}

/** Starts a launched test; the honest-test checklist must be confirmed (D-014 п.8). */
export function startExperiment(experiment: Experiment, context: DomainContext): Experiment {
  if (experiment.checksConfirmedAt === undefined) {
    throw new DomainError(
      'invariant_violation',
      'The honest-test checklist must be confirmed before the experiment starts',
      { experiment_id: experiment.id },
    );
  }
  return transition(experiment, experimentLifecycle, experimentSchema, 'running', context, {
    startedAt: context.at,
  });
}

/** Stop-loss hit, kill switch or owner decision. */
export function stopExperiment(
  experiment: Experiment,
  reason: string,
  context: DomainContext,
): Experiment {
  return transition(experiment, experimentLifecycle, experimentSchema, 'stopped', context, {
    stopReason: reason,
    endedAt: context.at,
  });
}

export function completeExperiment(
  experiment: Experiment,
  result: ExperimentResult,
  context: DomainContext,
): Experiment {
  return transition(experiment, experimentLifecycle, experimentSchema, 'completed', context, {
    result,
    endedAt: experiment.endedAt ?? context.at,
  });
}

export function cancelExperiment(experiment: Experiment, context: DomainContext): Experiment {
  return transition(experiment, experimentLifecycle, experimentSchema, 'cancelled', context);
}

/** Why a test stopped; the automatic reasons decide the hypothesis verdict. */
export const STOP_REASONS = {
  stopLoss: 'Stop-loss reached',
  budget: 'Test budget spent',
  owner: 'Stopped by the owner',
} as const;

/**
 * The automatic stop of a running test after its spend changed (§2.19, PHASE 15): the whole
 * test budget is spent, or the stop-loss is spent while the success metric is not reached.
 */
export function automaticStopReason(
  experiment: Experiment,
  spent: Money,
  reached: boolean,
): string | undefined {
  if (experiment.status !== 'running') return undefined;
  if (compareMoney(spent, experiment.testBudget) >= 0) return STOP_REASONS.budget;
  if (!reached && compareMoney(spent, experiment.stopLoss) >= 0) return STOP_REASONS.stopLoss;
  return undefined;
}

/**
 * What the data says about the hypothesis (§7.3): the metric reached — confirmed; not reached
 * after the stop-loss or the whole budget — refuted; otherwise inconclusive.
 */
export function hypothesisVerdict(
  experiment: Experiment,
  reached: boolean,
): Extract<HypothesisStatus, 'confirmed' | 'refuted' | 'inconclusive'> {
  if (reached) return 'confirmed';
  return experiment.stopReason === STOP_REASONS.stopLoss ||
    experiment.stopReason === STOP_REASONS.budget
    ? 'refuted'
    : 'inconclusive';
}

/** Whole days since the test started, and whether its calendar limit has passed. */
export function experimentDay(
  experiment: Experiment,
  at: Timestamp,
): { readonly day: number; readonly overdue: boolean } | undefined {
  if (experiment.startedAt === undefined) return undefined;
  const end = experiment.endedAt ?? at;
  const day = Math.floor((Date.parse(end) - Date.parse(experiment.startedAt)) / 86_400_000) + 1;
  return { day, overdue: day > experiment.buildBudget.maxCalendarDays };
}
