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
  actorSchema,
  principalIdSchema,
  text,
  type Actor,
  type PrincipalId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/**
 * Actor types that act only through a registered identity. `owner` (authenticated by its
 * channel) and `system` (the platform's own processes) are built in.
 */
export const REGISTERED_ACTOR_TYPES = ['member', 'agent', 'integration'] as const;
export type RegisteredActorType = (typeof REGISTERED_ACTOR_TYPES)[number];

export function needsPrincipal(actor: Actor): boolean {
  return (REGISTERED_ACTOR_TYPES as readonly string[]).includes(actor.type);
}

export const PRINCIPAL_STATUSES = ['pending', 'active', 'suspended', 'revoked'] as const;
export type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

/** Access is granted by the owner, can be paused and returned, and revocation is final. */
export const principalLifecycle = defineStateMachine<PrincipalStatus>('principal', {
  pending: ['active', 'revoked'],
  active: ['suspended', 'revoked'],
  suspended: ['active', 'revoked'],
  revoked: [],
});

const principalActorSchema = actorSchema.refine(needsPrincipal, {
  message: 'only members, agents and integrations are registered principals',
});

export const newPrincipalSchema = z.strictObject({
  /** The actor this identity stands for, e.g. `{ type: 'agent', id: 'research-agent' }`. */
  actor: principalActorSchema,
  displayName: text(100),
  /** What the access is for; shown to the owner on the approval card. */
  purpose: text(500),
});
export type NewPrincipal = z.infer<typeof newPrincipalSchema>;

export const principalSchema = z.object({
  ...newPrincipalSchema.shape,
  id: principalIdSchema,
  status: z.enum(PRINCIPAL_STATUSES),
  ...mutableMetaShape,
});
export type Principal = z.infer<typeof principalSchema>;

function assertOwnerOrSystem(context: DomainContext, action: string): void {
  if (context.actor.type !== 'owner' && context.actor.type !== 'system') {
    throw new DomainError('owner_required', `Only the owner or the system may ${action}`, {
      action,
      actor_type: context.actor.type,
    });
  }
}

/**
 * A request for access: the identity waits for the owner's approval (§2.7). Proposed by the
 * platform when it sets up an integration or agent, or by the owner.
 */
export function proposePrincipal(
  data: NewPrincipal,
  context: CreateContext<PrincipalId>,
): Principal {
  assertOwnerOrSystem(context, 'propose access');
  return parseEntity(principalSchema, 'principal', {
    ...data,
    id: context.id,
    status: 'pending',
    ...mutableMeta(context),
  });
}

/** The owner grants the requested access. */
export function approvePrincipal(principal: Principal, context: DomainContext): Principal {
  assertOwner(context.actor, 'grant access');
  return transition(principal, principalLifecycle, principalSchema, 'active', context);
}

/** Pauses access; only the owner (automatic suspension arrives with agents, PHASE 10). */
export function suspendPrincipal(principal: Principal, context: DomainContext): Principal {
  assertOwner(context.actor, 'suspend access');
  return transition(principal, principalLifecycle, principalSchema, 'suspended', context);
}

/** Returns paused access; only the owner. */
export function reactivatePrincipal(principal: Principal, context: DomainContext): Principal {
  assertOwner(context.actor, 'return access');
  return transition(principal, principalLifecycle, principalSchema, 'active', context);
}

/** Revokes access for good (also rejects a pending request); only the owner. */
export function revokePrincipal(principal: Principal, context: DomainContext): Principal {
  assertOwner(context.actor, 'revoke access');
  return transition(principal, principalLifecycle, principalSchema, 'revoked', context);
}
