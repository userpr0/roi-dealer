import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  ENTITY_TYPES,
  principalIdSchema,
  proposePrincipal,
  approvePrincipal,
  suspendPrincipal,
  type Actor,
} from '@roi-dealer/domain';
import {
  assertPermitted,
  decideAccess,
  ENTITY_WRITE_PERMISSIONS,
  isPermitted,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  writePermission,
  type Permission,
} from '@roi-dealer/policies';
import { AGENT, createCtx, ctx, MEMBER, OWNER, SYSTEM } from '../../support/domain.js';

const INTEGRATION: Actor = { type: 'integration', id: 'reddit-api' };

/** Permissions nobody but the owner may ever hold (§2.3, §2.7). */
const OWNER_ONLY: readonly Permission[] = ['decision.record', 'access.manage', 'panel.use'];

describe('roles and permissions (PHASE 04)', () => {
  it('give the owner every permission', () => {
    for (const permission of PERMISSIONS) expect(isPermitted(OWNER, permission)).toBe(true);
  });

  it('keep decisions, access and the panel with the owner only', () => {
    for (const type of ACTOR_TYPES.filter((candidate) => candidate !== 'owner')) {
      for (const permission of OWNER_ONLY) {
        expect(ROLE_PERMISSIONS[type]).not.toContain(permission);
      }
    }
  });

  it('never let an AI agent approve, stop the system or change access (§2.3)', () => {
    for (const permission of [
      'approval.update',
      'decision.record',
      'system.control',
      'access.propose',
      'access.manage',
      'cost.record',
      'reward.write',
    ] as const) {
      expect(isPermitted(AGENT, permission)).toBe(false);
    }
    expect(isPermitted(AGENT, 'research.write')).toBe(true);
    expect(isPermitted(AGENT, 'approval.request')).toBe(true);
  });

  it('let an integration deliver only evidence and costs', () => {
    expect(ROLE_PERMISSIONS.integration).toEqual(['evidence.write', 'cost.record']);
  });

  it('let the system run automations but not decide', () => {
    expect(isPermitted(SYSTEM, 'system.control')).toBe(true);
    expect(isPermitted(SYSTEM, 'approval.update')).toBe(true);
    expect(isPermitted(SYSTEM, 'decision.record')).toBe(false);
    expect(isPermitted(SYSTEM, 'access.manage')).toBe(false);
  });

  it('only grant permissions that exist', () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of permissions) expect(PERMISSIONS).toContain(permission);
    }
  });
});

describe('write permissions', () => {
  it('cover every entity; append-only records are never updated', () => {
    expect(Object.keys(ENTITY_WRITE_PERMISSIONS).sort()).toEqual([...ENTITY_TYPES].sort());
    for (const entity of ['evidence', 'decision', 'cost_entry', 'knowledge_asset'] as const) {
      expect(ENTITY_WRITE_PERMISSIONS[entity].update).toBeUndefined();
      expect(() => writePermission(entity, 'update')).toThrow(
        expect.objectContaining({ code: 'invariant_violation' }),
      );
    }
  });

  it('map writes to permissions', () => {
    expect(writePermission('decision', 'create')).toBe('decision.record');
    expect(writePermission('approval_request', 'update')).toBe('approval.update');
    expect(writePermission('principal', 'create')).toBe('access.propose');
    expect(writePermission('principal', 'update')).toBe('access.manage');
  });
});

describe('decideAccess', () => {
  const proposed = proposePrincipal(
    { actor: AGENT, displayName: 'Research agent', purpose: 'Finds pains' },
    createCtx(principalIdSchema, SYSTEM),
  );
  const active = approvePrincipal(proposed, ctx(OWNER, 1));

  it('allows the owner and the system without a registered identity', () => {
    expect(decideAccess(OWNER, 'decision.record', undefined)).toEqual({ allowed: true });
    expect(decideAccess(SYSTEM, 'system.control', undefined)).toEqual({ allowed: true });
  });

  it('requires an active identity for members, agents and integrations', () => {
    expect(decideAccess(AGENT, 'research.write', active)).toEqual({ allowed: true });
    expect(decideAccess(AGENT, 'research.write', undefined)).toEqual({
      allowed: false,
      reason: 'unknown_principal',
    });
    expect(decideAccess(AGENT, 'research.write', proposed)).toEqual({
      allowed: false,
      reason: 'principal_not_active',
    });
    expect(decideAccess(AGENT, 'research.write', suspendPrincipal(active, ctx(OWNER, 2)))).toEqual({
      allowed: false,
      reason: 'principal_not_active',
    });
    expect(decideAccess(MEMBER, 'journal.read', undefined)).toMatchObject({ allowed: false });
  });

  it('checks the role before the identity', () => {
    expect(decideAccess(AGENT, 'decision.record', active)).toEqual({
      allowed: false,
      reason: 'missing_permission',
    });
    expect(decideAccess(INTEGRATION, 'research.write', undefined)).toEqual({
      allowed: false,
      reason: 'missing_permission',
    });
  });

  it('assertPermitted throws permission_denied', () => {
    expect(() => assertPermitted(AGENT, 'access.manage')).toThrow(
      expect.objectContaining({
        code: 'permission_denied',
        details: { actor_type: 'agent', permission: 'access.manage' },
      }),
    );
    expect(() => assertPermitted(OWNER, 'access.manage')).not.toThrow();
  });
});
