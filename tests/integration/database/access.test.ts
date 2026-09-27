import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvePrincipal,
  createDecision,
  createEvidence,
  createSource,
  decisionIdSchema,
  evidenceIdSchema,
  principalIdSchema,
  proposePrincipal,
  reactivatePrincipal,
  revokePrincipal,
  sourceIdSchema,
  suspendPrincipal,
  type Actor,
  type Source,
} from '@roi-dealer/domain';
import { ConstraintViolationError, translateError, type Database } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  evidenceData,
  OWNER,
  sourceData,
  SYSTEM,
} from '../../support/domain.js';
import {
  createTestDatabase,
  registerPrincipal,
  type TestDatabase,
} from '../../support/database.js';

let test: TestDatabase;
let db: Database;
let source: Source;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  source = createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));
  await db.repositories.sources.insert(source);
});

afterAll(async () => {
  await test.drop();
});

async function rejection(statement: () => Promise<unknown>): Promise<ConstraintViolationError> {
  try {
    await statement();
  } catch (error) {
    const translated = translateError(error);
    if (translated instanceof ConstraintViolationError) return translated;
    throw error;
  }
  throw new Error('The database accepted an invalid write');
}

const evidenceBy = (actor: Actor) =>
  createEvidence(evidenceData(source.id), createCtx(evidenceIdSchema, actor, 1));

async function lastDenial() {
  const [entry] = await db.access.list({ decision: 'denied', limit: 1 });
  return entry;
}

describe('principals', () => {
  it('are proposed by the system, granted by the owner and found by actor', async () => {
    const actor: Actor = { type: 'integration', id: 'forum-api' };
    const proposed = proposePrincipal(
      { actor, displayName: 'Forum API', purpose: 'Delivers forum posts as evidence' },
      createCtx(principalIdSchema, SYSTEM),
    );
    await db.repositories.principals.insert(proposed);
    expect(await db.repositories.principals.getByActor(actor)).toEqual(proposed);
    expect(await db.repositories.principals.listByStatus('pending')).toContainEqual(proposed);

    const active = approvePrincipal(proposed, ctx(OWNER, 1));
    await db.repositories.principals.update(active, OWNER);
    expect((await db.repositories.principals.getByActor(actor))?.status).toBe('active');
    expect(await db.repositories.principals.getByActor({ type: 'agent', id: 'nobody' })).toBe(
      undefined,
    );
  });

  it('keep one identity per actor, never re-pointed, and revocation is final', async () => {
    const principal = await registerPrincipal(db, { type: 'agent', id: 'one-off-agent' });
    const duplicate = proposePrincipal(
      { actor: principal.actor, displayName: 'Again', purpose: 'Second grant' },
      createCtx(principalIdSchema, SYSTEM),
    );
    await expect(
      rejection(() => db.repositories.principals.insert(duplicate)),
    ).resolves.toMatchObject({ kind: 'unique', constraint: 'principals_actor_key' });

    await expect(
      rejection(
        () => db.sql`
          update principals set actor_id = 'other-agent', version = version + 1
          where id = ${principal.id}
        `,
      ),
    ).resolves.toMatchObject({ constraint: 'principals_actor_immutable' });

    const revoked = revokePrincipal(principal, ctx(OWNER, 5));
    await db.repositories.principals.update(revoked, OWNER);
    await expect(
      rejection(
        () => db.sql`
          update principals set status = 'active', version = version + 1 where id = ${principal.id}
        `,
      ),
    ).resolves.toMatchObject({ constraint: 'principals_revoked_final' });
  });
});

describe('every write checks access', () => {
  it('lets a registered agent write research data', async () => {
    const evidence = evidenceBy(AGENT);
    await db.repositories.evidence.insert(evidence);
    expect(await db.repositories.evidence.getById(evidence.id)).toEqual(evidence);
  });

  it('refuses an unregistered agent and records the attempt', async () => {
    const stranger: Actor = { type: 'agent', id: 'unknown-agent' };
    await expect(db.repositories.evidence.insert(evidenceBy(stranger))).rejects.toMatchObject({
      name: 'DomainError',
      code: 'permission_denied',
      details: expect.objectContaining({ reason: 'unknown_principal' }) as unknown,
    });
    expect(await lastDenial()).toMatchObject({
      channel: 'database',
      actorType: 'agent',
      actorId: 'unknown-agent',
      permission: 'evidence.write',
      decision: 'denied',
      reason: 'unknown_principal',
    });
  });

  it('refuses a role without the permission, even for an active identity', async () => {
    const decision = createDecision(
      {
        subject: { type: 'opportunity', id: uuidv7() },
        outcome: 'approve',
        rationale: 'An agent may not decide',
        evidenceIds: [],
      },
      createCtx(decisionIdSchema, OWNER, 2),
    );
    await expect(
      db.repositories.decisions.insert({ ...decision, createdBy: AGENT }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await lastDenial()).toMatchObject({
      permission: 'decision.record',
      reason: 'missing_permission',
    });

    const integration = await registerPrincipal(db, { type: 'integration', id: 'billing' });
    await expect(
      db.repositories.sources.insert(
        createSource(sourceData(), createCtx(sourceIdSchema, integration.actor, 3)),
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await db.repositories.evidence.insert(evidenceBy(integration.actor));
  });

  it('cuts off a suspended identity at once and restores it on return', async () => {
    const principal = await registerPrincipal(db, { type: 'agent', id: 'pausable-agent' });
    const suspended = suspendPrincipal(principal, ctx(OWNER, 10));
    await db.repositories.principals.update(suspended, OWNER);

    await expect(
      db.repositories.evidence.insert(evidenceBy(principal.actor)),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      details: expect.objectContaining({ reason: 'principal_not_active' }) as unknown,
    });

    await db.repositories.principals.update(reactivatePrincipal(suspended, ctx(OWNER, 11)), OWNER);
    await db.repositories.evidence.insert(evidenceBy(principal.actor));
  });

  it('records a refusal although its transaction rolls back, with the correlation id', async () => {
    const stranger: Actor = { type: 'agent', id: 'rolled-back-agent' };
    await expect(
      db.transaction(
        async ({ repositories }) => {
          await repositories.sources.insert(
            createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 12)),
          );
          await repositories.evidence.insert(evidenceBy(stranger));
        },
        { correlationId: 'tg-update-4242' },
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await lastDenial()).toMatchObject({
      actorId: 'rolled-back-agent',
      correlationId: 'tg-update-4242',
    });
  });

  it('is enforced by the database even around the repositories', async () => {
    const evidence = evidenceBy({ type: 'agent', id: 'raw-sql-agent' });
    await expect(
      rejection(() =>
        db.sql.begin(async (tx) => {
          await tx`
            insert into events (id, type, aggregate_type, aggregate_id, aggregate_version,
                                occurred_at, actor_type, actor_id, payload)
            values (${uuidv7()}, 'evidence.created', 'evidence', ${evidence.id}, 1, now(),
                    'agent', 'raw-sql-agent', ${tx.json({ snapshot: {} })})
          `;
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'access_denied',
      constraint: 'events_actor_principal_active',
    });
  });
});

describe('access log', () => {
  it('lists newest first, counts by period and decision', async () => {
    await db.access.record({
      occurredAt: at(100),
      channel: 'telegram',
      actorType: 'owner',
      actorId: 'telegram:1001',
      permission: 'journal.read',
      decision: 'allowed',
      correlationId: 'tg-update-1',
    });
    await db.access.record({
      occurredAt: at(101),
      channel: 'telegram',
      actorId: 'telegram:666',
      permission: 'panel.use',
      decision: 'denied',
      reason: 'not_owner',
    });

    const [newest] = await db.access.list({ from: at(100), to: at(102) });
    expect(newest).toMatchObject({ actorId: 'telegram:666', occurredAt: at(101) });
    expect(newest).not.toHaveProperty('actorType');
    expect(await db.access.count({ from: at(100), to: at(102) })).toBe(2);
    expect(await db.access.count({ from: at(100), to: at(102), decision: 'denied' })).toBe(1);
  });

  it('is append-only and keeps a reason exactly for denials', async () => {
    await expect(rejection(() => db.sql`delete from access_log`)).resolves.toMatchObject({
      kind: 'forbidden_change',
    });
    await expect(
      rejection(() => db.sql`update access_log set decision = 'allowed'`),
    ).resolves.toMatchObject({ kind: 'forbidden_change' });
    await expect(
      rejection(() =>
        db.access.record({
          channel: 'telegram',
          actorId: 'telegram:1',
          permission: 'panel.use',
          decision: 'denied',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'check', constraint: 'access_log_reason_for_denials' });
  });
});
