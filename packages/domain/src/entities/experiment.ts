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
import {
  compareMoney,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  sumMoney,
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
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';
import { assertApprovalCovers, type ApprovalRequest } from './approval.js';
import type { Hypothesis } from './hypothesis.js';

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
    approvalRequestId: approvalRequestIdSchema.optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    stopReason: text(500).optional(),
    result: experimentResultSchema.optional(),
    ...mutableMetaShape,
  })
  .refine(stopLossWithinBudget, STOP_LOSS_RULE)
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
    ...mutableMeta(context),
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

export function startExperiment(experiment: Experiment, context: DomainContext): Experiment {
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
