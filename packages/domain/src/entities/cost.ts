import { z } from 'zod';
import { immutableMeta, immutableMetaShape, parseEntity, type CreateContext } from '../entity.js';
import { DomainError } from '../errors.js';
import {
  addMoney,
  compareMoney,
  positiveMoneySchema,
  subtractMoney,
  ZERO_USD,
  type Money,
} from '../money.js';
import {
  approvalRequestIdSchema,
  costEntryIdSchema,
  experimentIdSchema,
  hypothesisIdSchema,
  opportunityIdSchema,
  text,
  timestampSchema,
  type CostEntryId,
  type Timestamp,
} from '../primitives.js';
import {
  assertApprovalCovers,
  DEFAULT_APPROVAL_POLICY,
  requiresOwnerApproval,
  type ApprovalPolicy,
  type ApprovalRequest,
} from './approval.js';
import { experimentTotalBudget, type Experiment } from './experiment.js';

/** Cost accounting from day one (§2.8). */
export const COST_CATEGORIES = [
  'ai',
  'api',
  'infrastructure',
  'storage',
  'media',
  'ads',
  'human',
  'refund',
  'vendor',
  'other',
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

const newCostEntryShape = {
  category: z.enum(COST_CATEGORIES),
  amount: positiveMoneySchema,
  description: text(500),
  incurredAt: timestampSchema,
  /** A new subscription or other repeating charge (always needs approval, D-006). */
  recurring: z.boolean(),
  allocation: z.strictObject({
    opportunityId: opportunityIdSchema.optional(),
    hypothesisId: hypothesisIdSchema.optional(),
    experimentId: experimentIdSchema.optional(),
  }),
  approvalRequestId: approvalRequestIdSchema.optional(),
  /** Corrections are new entries (§2.2): a reversal cancels the referenced entry. */
  reversalOf: costEntryIdSchema.optional(),
};

/** An immutable line of the cost ledger. */
export const newCostEntrySchema = z.strictObject(newCostEntryShape);
export type NewCostEntry = z.infer<typeof newCostEntrySchema>;

export const costEntrySchema = z.object({
  ...newCostEntryShape,
  id: costEntryIdSchema,
  ...immutableMetaShape,
});
export type CostEntry = z.infer<typeof costEntrySchema>;

/**
 * Records a cost. Spend above the approval threshold, and any recurring charge,
 * must reference an approved request that covers the amount (D-006).
 */
export function recordCostEntry(
  data: NewCostEntry,
  context: CreateContext<CostEntryId>,
  approval?: ApprovalRequest,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): CostEntry {
  if (data.reversalOf === undefined) {
    const kind = data.recurring ? 'recurring_payment' : 'spend';
    if (requiresOwnerApproval({ kind, amount: data.amount }, policy)) {
      if (data.approvalRequestId === undefined) {
        throw new DomainError('approval_required', 'This cost needs an approved request', {
          kind,
        });
      }
      assertApprovalCovers(approval, { id: data.approvalRequestId, kind, amount: data.amount });
    }
  }
  return parseEntity(costEntrySchema, 'cost_entry', {
    ...data,
    id: context.id,
    ...immutableMeta(context),
  });
}

/**
 * Spend of a launched experiment (PHASE 15, D-006, D-007): covered by the experiment's approved
 * launch request, and never above its approved budget together with what was spent before —
 * more needs a new approval.
 */
export function recordExperimentCost(
  data: {
    readonly amount: Money;
    readonly description: string;
    readonly incurredAt: Timestamp;
    readonly category?: CostCategory | undefined;
  },
  experiment: Experiment,
  approval: ApprovalRequest | undefined,
  spent: Money,
  context: CreateContext<CostEntryId>,
): CostEntry {
  if (experiment.status !== 'running' && experiment.status !== 'stopped') {
    throw new DomainError('invariant_violation', 'Only a launched experiment records spend', {
      experiment_status: experiment.status,
    });
  }
  const budget = experimentTotalBudget(experiment);
  assertApprovalCovers(approval, {
    ...(experiment.approvalRequestId === undefined ? {} : { id: experiment.approvalRequestId }),
    kind: 'experiment_launch',
    amount: budget,
    subject: { type: 'experiment', id: experiment.id },
  });
  if (compareMoney(addMoney(spent, data.amount), budget) > 0) {
    throw new DomainError(
      'approval_required',
      'Spend above the approved experiment budget needs a new approval',
      { experiment_id: experiment.id },
    );
  }
  return parseEntity(costEntrySchema, 'cost_entry', {
    category: data.category ?? 'ads',
    amount: data.amount,
    description: data.description,
    incurredAt: data.incurredAt,
    recurring: false,
    allocation: {
      opportunityId: experiment.opportunityId,
      hypothesisId: experiment.hypothesisId,
      experimentId: experiment.id,
    },
    approvalRequestId: approval?.id,
    id: context.id,
    ...immutableMeta(context),
  });
}

/**
 * Money returned to a test's customers (PHASE 16): a `refund` cost of the experiment, at most
 * what it received minus earlier refunds. It is the customers' money, not a spend of the
 * company, so it needs no approval (D-006); it does not count towards the stop-loss.
 */
export function recordRefund(
  data: { readonly amount: Money; readonly description: string; readonly incurredAt: Timestamp },
  experiment: Experiment,
  refundable: Money,
  context: CreateContext<CostEntryId>,
): CostEntry {
  if (!['running', 'stopped', 'completed'].includes(experiment.status)) {
    throw new DomainError('invariant_violation', 'Only a launched experiment has refunds', {
      experiment_status: experiment.status,
    });
  }
  if (compareMoney(data.amount, refundable) > 0) {
    throw new DomainError('invariant_violation', 'A refund cannot exceed the money received', {
      experiment_id: experiment.id,
    });
  }
  return parseEntity(costEntrySchema, 'cost_entry', {
    category: 'refund',
    amount: data.amount,
    description: data.description,
    incurredAt: data.incurredAt,
    recurring: false,
    allocation: {
      opportunityId: experiment.opportunityId,
      hypothesisId: experiment.hypothesisId,
      experimentId: experiment.id,
    },
    id: context.id,
    ...immutableMeta(context),
  });
}

export interface CostSummary {
  readonly total: Money;
  readonly byCategory: Readonly<Partial<Record<CostCategory, Money>>>;
}

/** Deterministic totals in code (§7.3): reversal entries subtract their amount. */
export function summarizeCosts(entries: readonly CostEntry[]): CostSummary {
  let total = ZERO_USD;
  const byCategory: Partial<Record<CostCategory, Money>> = {};
  for (const entry of entries) {
    const apply = entry.reversalOf === undefined ? addMoney : subtractMoney;
    total = apply(total, entry.amount);
    byCategory[entry.category] = apply(byCategory[entry.category] ?? ZERO_USD, entry.amount);
  }
  return { total, byCategory };
}
