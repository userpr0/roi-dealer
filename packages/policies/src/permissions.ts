import {
  DomainError,
  needsPrincipal,
  type Actor,
  type ActorType,
  type EntityType,
  type Principal,
} from '@roi-dealer/domain';

/*
 * Roles and permissions (PHASE 04, constitution §2.3, §2.11): what each kind of actor may do.
 * The role of an actor is its type; members, agents and integrations additionally need an
 * active Principal. The domain still decides the details (who may resolve, which transitions).
 */

export const PERMISSIONS = [
  // Owner command center: using the bot at all, then views, audited in access_log.
  'panel.use',
  'status.read',
  'decisions.read',
  'journal.read',
  'history.read',
  'digest.read',
  'access.read',
  // Research: sources, signals, pains, opportunities, hypotheses, knowledge.
  'research.write',
  'evidence.write',
  // Human gates.
  'approval.request',
  'approval.update',
  'decision.record',
  // Experiments, money and contribution.
  'experiment.write',
  'cost.record',
  'contribution.write',
  'reward.write',
  // Controls.
  'system.control',
  'access.propose',
  'access.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Views of the owner command center. */
export const PANEL_READS = [
  'status.read',
  'decisions.read',
  'journal.read',
  'history.read',
  'digest.read',
  'access.read',
] as const satisfies readonly Permission[];

/**
 * Least privilege: every role gets only what its work needs. An AI agent proposes and never
 * decides, approves, stops the system or grants access (§2.3); an integration only delivers
 * evidence and costs.
 */
export const ROLE_PERMISSIONS: Readonly<Record<ActorType, readonly Permission[]>> = {
  owner: PERMISSIONS,
  system: [
    'digest.read',
    'research.write',
    'evidence.write',
    'approval.request',
    'approval.update',
    'experiment.write',
    'cost.record',
    'contribution.write',
    'reward.write',
    'system.control',
    'access.propose',
  ],
  agent: ['research.write', 'evidence.write', 'approval.request', 'experiment.write'],
  integration: ['evidence.write', 'cost.record'],
  member: [
    'decisions.read',
    'journal.read',
    'history.read',
    'research.write',
    'evidence.write',
    'approval.request',
  ],
};

export type WriteOperation = 'create' | 'update';

/** The permission each write needs; append-only records are only created. */
export const ENTITY_WRITE_PERMISSIONS: Readonly<
  Record<EntityType, { readonly create: Permission; readonly update?: Permission }>
> = {
  source: { create: 'research.write', update: 'research.write' },
  evidence: { create: 'evidence.write' },
  signal: { create: 'research.write', update: 'research.write' },
  pain: { create: 'research.write', update: 'research.write' },
  opportunity: { create: 'research.write', update: 'research.write' },
  decision: { create: 'decision.record' },
  approval_request: { create: 'approval.request', update: 'approval.update' },
  hypothesis: { create: 'research.write', update: 'research.write' },
  experiment: { create: 'experiment.write', update: 'experiment.write' },
  cost_entry: { create: 'cost.record' },
  contribution: { create: 'contribution.write', update: 'contribution.write' },
  reward: { create: 'reward.write', update: 'reward.write' },
  knowledge_asset: { create: 'research.write' },
  system_control: { create: 'system.control', update: 'system.control' },
  principal: { create: 'access.propose', update: 'access.manage' },
};

export function writePermission(entity: EntityType, operation: WriteOperation): Permission {
  const permissions = ENTITY_WRITE_PERMISSIONS[entity];
  const permission = operation === 'create' ? permissions.create : permissions.update;
  if (permission === undefined) {
    throw new DomainError('invariant_violation', `${entity} records are never updated`, {
      entity,
    });
  }
  return permission;
}

export function isPermitted(actor: Actor, permission: Permission): boolean {
  return ROLE_PERMISSIONS[actor.type].includes(permission);
}

/** Why access was refused; stored in access_log. */
export const DENIAL_REASONS = [
  'missing_permission',
  'unknown_principal',
  'principal_not_active',
  'not_owner',
  'not_private_chat',
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason };

/**
 * The full check: the role grants the permission and, for members, agents and integrations,
 * their Principal (looked up by the caller) is active.
 */
export function decideAccess(
  actor: Actor,
  permission: Permission,
  principal: Principal | undefined,
): AccessDecision {
  if (!isPermitted(actor, permission)) return { allowed: false, reason: 'missing_permission' };
  if (needsPrincipal(actor)) {
    if (principal === undefined) return { allowed: false, reason: 'unknown_principal' };
    if (principal.status !== 'active') return { allowed: false, reason: 'principal_not_active' };
  }
  return { allowed: true };
}

/** Throws `permission_denied` unless the role grants the permission (no principal lookup). */
export function assertPermitted(actor: Actor, permission: Permission): void {
  if (!isPermitted(actor, permission)) {
    throw new DomainError('permission_denied', `The ${actor.type} role may not ${permission}`, {
      actor_type: actor.type,
      permission,
    });
  }
}
