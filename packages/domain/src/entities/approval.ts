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
import { compareMoney, positiveMoneySchema, usd, type Money } from '../money.js';
import {
  actorSchema,
  approvalRequestIdSchema,
  entityRefSchema,
  text,
  timestampMs,
  timestampSchema,
  titleSchema,
  type ApprovalRequestId,
  type EntityRef,
  type Timestamp,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/** Human gates (§2.7) plus owner decisions D-006. */
export const APPROVAL_KINDS = [
  'spend',
  'recurring_payment',
  'payout',
  'asset_purchase',
  'experiment_launch',
  'opportunity_decision',
  'production_change',
  'legal',
  'secret_access',
  'policy_change',
  'budget_change',
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Kinds where the owner must see the money at stake. */
const KINDS_WITH_AMOUNT: ReadonlySet<ApprovalKind> = new Set([
  'spend',
  'recurring_payment',
  'payout',
  'asset_purchase',
  'budget_change',
  'experiment_launch',
]);

export interface ApprovalPolicy {
  /** One-off spend above this amount needs the owner's approval. */
  readonly spendThreshold: Money;
}

/** D-006: spend above $20 needs approval; every other kind always does. */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { spendThreshold: usd(2_000) };

export function requiresOwnerApproval(
  action: { readonly kind: ApprovalKind; readonly amount?: Money },
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): boolean {
  if (action.kind !== 'spend') return true;
  return action.amount === undefined || compareMoney(action.amount, policy.spendThreshold) > 0;
}

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const approvalLifecycle = defineStateMachine<ApprovalStatus>('approval_request', {
  pending: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: [],
});

const newApprovalRequestShape = {
  kind: z.enum(APPROVAL_KINDS),
  title: titleSchema,
  /** What the owner needs to know to decide: evidence, cost, risk. */
  summary: text(3_000),
  subject: entityRefSchema.optional(),
  amount: positiveMoneySchema.optional(),
  expiresAt: timestampSchema,
};

function hasRequiredAmount(request: { kind: ApprovalKind; amount?: Money | undefined }): boolean {
  return !KINDS_WITH_AMOUNT.has(request.kind) || request.amount !== undefined;
}
const AMOUNT_REQUIRED = {
  message: 'amount is required for money-related approvals',
  path: ['amount'],
};

export const newApprovalRequestSchema = z
  .strictObject(newApprovalRequestShape)
  .refine(hasRequiredAmount, AMOUNT_REQUIRED);
export type NewApprovalRequest = z.infer<typeof newApprovalRequestSchema>;

export const approvalResolutionSchema = z.strictObject({
  decidedBy: actorSchema,
  decidedAt: timestampSchema,
  comment: text(1_000).optional(),
});

export const approvalRequestSchema = z
  .object({
    ...newApprovalRequestShape,
    id: approvalRequestIdSchema,
    status: z.enum(APPROVAL_STATUSES),
    resolution: approvalResolutionSchema.optional(),
    ...mutableMetaShape,
  })
  .refine(hasRequiredAmount, AMOUNT_REQUIRED)
  .refine((request) => timestampMs(request.expiresAt) > timestampMs(request.createdAt), {
    message: 'expiresAt must be later than createdAt',
    path: ['expiresAt'],
  });
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export function createApprovalRequest(
  data: NewApprovalRequest,
  context: CreateContext<ApprovalRequestId>,
): ApprovalRequest {
  return parseEntity(approvalRequestSchema, 'approval_request', {
    ...data,
    id: context.id,
    status: 'pending',
    ...mutableMeta(context),
  });
}

export function isApprovalExpired(request: ApprovalRequest, at: Timestamp): boolean {
  return timestampMs(at) >= timestampMs(request.expiresAt);
}

/** The owner's button: approve or reject. Expired requests cannot be resolved. */
export function resolveApprovalRequest(
  request: ApprovalRequest,
  resolution: { readonly decision: 'approve' | 'reject'; readonly comment?: string | undefined },
  context: DomainContext,
): ApprovalRequest {
  assertOwner(context.actor, 'resolve approval requests');
  if (request.status === 'pending' && isApprovalExpired(request, context.at)) {
    throw new DomainError('approval_expired', 'The approval request has expired', {
      approval_request_id: request.id,
    });
  }
  return transition(
    request,
    approvalLifecycle,
    approvalRequestSchema,
    resolution.decision === 'approve' ? 'approved' : 'rejected',
    context,
    {
      resolution: {
        decidedBy: context.actor,
        decidedAt: context.at,
        ...(resolution.comment === undefined ? {} : { comment: resolution.comment }),
      },
    },
  );
}

export function expireApprovalRequest(
  request: ApprovalRequest,
  context: DomainContext,
): ApprovalRequest {
  if (!isApprovalExpired(request, context.at)) {
    throw new DomainError('invariant_violation', 'The approval request has not expired yet', {
      approval_request_id: request.id,
    });
  }
  return transition(request, approvalLifecycle, approvalRequestSchema, 'expired', context);
}

export function cancelApprovalRequest(
  request: ApprovalRequest,
  context: DomainContext,
): ApprovalRequest {
  return transition(request, approvalLifecycle, approvalRequestSchema, 'cancelled', context);
}

export interface ApprovalRequirement {
  readonly id?: ApprovalRequestId;
  readonly kind: ApprovalKind;
  readonly amount?: Money;
  readonly subject?: EntityRef;
}

/**
 * Throws `approval_required` unless `approval` is an approved request of the right kind
 * that covers the amount and refers to the same subject.
 */
export function assertApprovalCovers(
  approval: ApprovalRequest | undefined,
  requirement: ApprovalRequirement,
): void {
  const reject = (reason: string): never => {
    throw new DomainError('approval_required', `Owner approval required: ${reason}`, {
      kind: requirement.kind,
      approval_request_id: approval?.id,
    });
  };

  if (approval === undefined) return reject('no approval request');
  if (approval.status !== 'approved') return reject(`request is ${approval.status}`);
  if (requirement.id !== undefined && approval.id !== requirement.id) {
    return reject('a different request was referenced');
  }
  if (approval.kind !== requirement.kind) return reject(`request is for ${approval.kind}`);
  if (
    requirement.amount !== undefined &&
    (approval.amount === undefined || compareMoney(approval.amount, requirement.amount) < 0)
  ) {
    return reject('approved amount is lower than required');
  }
  if (
    requirement.subject !== undefined &&
    (approval.subject?.type !== requirement.subject.type ||
      approval.subject.id !== requirement.subject.id)
  ) {
    return reject('request is about a different subject');
  }
}
