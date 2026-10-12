import { describe, expect, it } from 'vitest';
import {
  approvePrincipal,
  needsPrincipal,
  principalIdSchema,
  principalSchema,
  proposePrincipal,
  reactivatePrincipal,
  revokePrincipal,
  suspendPrincipal,
  type Principal,
} from '@roi-dealer/domain';
import { AGENT, createCtx, ctx, MEMBER, OWNER, SYSTEM } from '../../support/domain.js';

function proposed(): Principal {
  return proposePrincipal(
    { actor: AGENT, displayName: 'Research agent', purpose: 'Collects evidence from forums' },
    createCtx(principalIdSchema, SYSTEM),
  );
}

describe('Principal (PHASE 04)', () => {
  it('is proposed by the system or the owner and waits for the owner', () => {
    expect(proposed()).toMatchObject({ status: 'pending', version: 1, actor: AGENT });
    expect(
      proposePrincipal(
        { actor: MEMBER, displayName: 'Anna', purpose: 'Research help' },
        createCtx(principalIdSchema, OWNER),
      ).status,
    ).toBe('pending');
    for (const actor of [AGENT, MEMBER]) {
      expect(() =>
        proposePrincipal(
          { actor: AGENT, displayName: 'Self', purpose: 'Grant myself access' },
          createCtx(principalIdSchema, actor),
        ),
      ).toThrow(expect.objectContaining({ code: 'owner_required' }));
    }
  });

  it('registers only members, agents and integrations', () => {
    for (const actor of [OWNER, SYSTEM]) {
      expect(needsPrincipal(actor)).toBe(false);
      expect(() =>
        proposePrincipal(
          { actor, displayName: 'Built in', purpose: 'Not registrable' },
          createCtx(principalIdSchema, SYSTEM),
        ),
      ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));
    }
    expect(needsPrincipal({ type: 'integration', id: 'reddit-api' })).toBe(true);
  });

  it('is granted, suspended, returned and revoked only by the owner', () => {
    const request = proposed();
    for (const actor of [SYSTEM, AGENT]) {
      expect(() => approvePrincipal(request, ctx(actor, 1))).toThrow(
        expect.objectContaining({ code: 'owner_required' }),
      );
    }
    const active = approvePrincipal(request, ctx(OWNER, 1));
    expect(active).toMatchObject({ status: 'active', version: 2 });
    expect(() => suspendPrincipal(active, ctx(SYSTEM, 2))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
    const suspended = suspendPrincipal(active, ctx(OWNER, 2));
    expect(() => reactivatePrincipal(suspended, ctx(SYSTEM, 3))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
    const returned = reactivatePrincipal(suspended, ctx(OWNER, 3));
    expect(returned).toMatchObject({ status: 'active', version: 4 });
    const revoked = revokePrincipal(returned, ctx(OWNER, 4));
    expect(revoked.status).toBe('revoked');
  });

  it('makes revocation final and rejects a pending request by revoking it', () => {
    const rejected = revokePrincipal(proposed(), ctx(OWNER, 1));
    expect(rejected.status).toBe('revoked');
    for (const next of [
      () => approvePrincipal(rejected, ctx(OWNER, 2)),
      () => reactivatePrincipal(rejected, ctx(OWNER, 2)),
      () => suspendPrincipal(rejected, ctx(OWNER, 2)),
    ]) {
      expect(next).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
    }
  });

  it('validates the stored shape', () => {
    expect(principalSchema.safeParse({ ...proposed(), displayName: ' ' }).success).toBe(false);
    expect(principalSchema.safeParse({ ...proposed(), actor: OWNER }).success).toBe(false);
  });
});
