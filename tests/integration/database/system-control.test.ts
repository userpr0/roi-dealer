import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approvalRequestIdSchema,
  AUTOMATION_CONTROL_ID,
  createApprovalRequest,
  createSystemControl,
  pauseSystem,
  resolveApprovalRequest,
  resumeSystem,
  systemControlIdSchema,
  usd,
  type ApprovalRequest,
  type SystemControl,
} from '@roi-dealer/domain';
import { ConstraintViolationError, translateError, type Database } from '@roi-dealer/database';
import { at, createCtx, ctx, OWNER, SYSTEM } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

let test: TestDatabase;
let db: Database;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
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

async function automation(): Promise<SystemControl> {
  const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) throw new Error('migration 0003 did not create the switch');
  return control;
}

describe('automation kill switch (migration 0003)', () => {
  it('exists in every database, running, with its creation event', async () => {
    const control = await automation();
    expect(control).toMatchObject({
      id: AUTOMATION_CONTROL_ID,
      key: 'automation',
      status: 'running',
      version: 1,
      createdBy: { type: 'system', id: 'migration' },
    });

    const [created, ...rest] = await db.events.history({
      type: 'system_control',
      id: AUTOMATION_CONTROL_ID,
    });
    expect(rest).toEqual([]);
    expect(created).toMatchObject({
      type: 'system_control.created',
      aggregateVersion: 1,
      occurredAt: control.createdAt,
      actor: { type: 'system', id: 'migration' },
      correlationId: 'migration:0003_system_control',
    });
    // The seeded snapshot is exactly the stored entity.
    expect(created?.payload.snapshot).toEqual(control);
  });

  it('is paused and resumed through the repository with events of the owner', async () => {
    const control = await automation();
    const paused = pauseSystem(control, 'Проверяю расходы', ctx(OWNER, 1));
    const resumed = resumeSystem(paused, ctx(OWNER, 2));

    await db.transaction((scope) => scope.repositories.systemControls.update(paused, OWNER), {
      correlationId: 'tg-update-1',
    });
    expect(await automation()).toEqual(paused);
    await db.repositories.systemControls.update(resumed, OWNER);
    expect(await automation()).toEqual(resumed);

    const history = await db.events.history({ type: 'system_control', id: control.id });
    expect(history.slice(1)).toMatchObject([
      {
        type: 'system_control.updated',
        aggregateVersion: 2,
        actor: OWNER,
        correlationId: 'tg-update-1',
        payload: { snapshot: { status: 'paused', reason: 'Проверяю расходы' } },
      },
      {
        type: 'system_control.updated',
        aggregateVersion: 3,
        payload: { previousStatus: 'paused', snapshot: { status: 'running' } },
      },
    ]);
    expect(history[2]?.payload.snapshot).not.toHaveProperty('reason');
  });

  it('has exactly one automation switch', async () => {
    const second = createSystemControl('automation', createCtx(systemControlIdSchema, SYSTEM));
    await expect(
      rejection(() => db.repositories.systemControls.insert(second)),
    ).resolves.toMatchObject({ kind: 'unique', constraint: 'system_controls_key_key' });
  });

  it('keeps a reason exactly while paused and is never deleted', async () => {
    await expect(
      rejection(
        () => db.sql`
          update system_controls set status = 'paused', version = version + 1
          where key = 'automation'
        `,
      ),
    ).resolves.toMatchObject({
      kind: 'check',
      constraint: 'system_controls_reason_matches_status',
    });
    await expect(
      rejection(() => db.sql`delete from system_controls where key = 'automation'`),
    ).resolves.toMatchObject({ kind: 'forbidden_change' });
  });
});

describe('listByStatus', () => {
  function request(minutes: number, title: string): ApprovalRequest {
    return createApprovalRequest(
      {
        kind: 'spend',
        title,
        summary: 'Test request',
        amount: usd(2_500),
        expiresAt: at(minutes + 600),
      },
      createCtx(approvalRequestIdSchema, SYSTEM, minutes),
    );
  }

  it('returns the entities in a status, least recently changed first, up to the limit', async () => {
    const later = request(20, 'Later');
    const earlier = request(10, 'Earlier');
    const decided = request(5, 'Decided');
    for (const entity of [later, earlier, decided]) {
      await db.repositories.approvalRequests.insert(entity);
    }
    await db.repositories.approvalRequests.update(
      resolveApprovalRequest(decided, { decision: 'approve' }, ctx(OWNER, 30)),
      OWNER,
    );

    const pending = await db.repositories.approvalRequests.listByStatus('pending');
    expect(pending.map((entity) => entity.title)).toEqual(['Earlier', 'Later']);
    expect(pending[0]).toEqual(earlier);

    const first = await db.repositories.approvalRequests.listByStatus('pending', { limit: 1 });
    expect(first.map((entity) => entity.title)).toEqual(['Earlier']);
    const approved = await db.repositories.approvalRequests.listByStatus('approved');
    expect(approved.map((entity) => entity.id)).toEqual([decided.id]);
    expect(await db.repositories.approvalRequests.listByStatus('expired')).toEqual([]);
  });
});
