import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeSourceStatus,
  createSource,
  sourceIdSchema,
  toTimestamp,
  type Source,
} from '@roi-dealer/domain';
import {
  ConstraintViolationError,
  InvalidWriteError,
  translateError,
  type Database,
} from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, createCtx, ctx, OWNER, sourceData, SYSTEM } from '../../support/domain.js';
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

const newSource = (): Source => createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));

/** A source created at a fixed instant, to query a period no other test writes into. */
const sourceAt = (iso: string): Source =>
  createSource(sourceData(), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: AGENT,
    at: toTimestamp(new Date(iso)),
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

describe('events written by the repositories', () => {
  it('record the creation with its actor and a snapshot', async () => {
    const source = newSource();
    await db.repositories.sources.insert(source);

    const [created] = await db.events.history({ type: 'source', id: source.id });

    expect(created).toMatchObject({
      type: 'source.created',
      aggregate: { type: 'source', id: source.id },
      aggregateVersion: 1,
      occurredAt: source.createdAt,
      actor: SYSTEM,
      payload: { snapshot: source },
    });
    expect(created?.correlationId).toBeUndefined();
    expect(created?.recordedAt).toMatch(/Z$/);
  });

  it('record every version with the previous status and the acting person', async () => {
    const source = newSource();
    const paused = changeSourceStatus(source, 'paused', ctx(OWNER, 5));
    const retired = changeSourceStatus(paused, 'retired', ctx(OWNER, 6));
    await db.repositories.sources.insert(source);
    await db.repositories.sources.update(paused, OWNER);
    await db.repositories.sources.update(retired, OWNER);

    const history = await db.events.history({ type: 'source', id: source.id });

    expect(history.map((event) => event.type)).toEqual([
      'source.created',
      'source.updated',
      'source.updated',
    ]);
    expect(history.map((event) => event.payload.snapshot)).toEqual([source, paused, retired]);
    expect(history.map((event) => event.payload.previousStatus)).toEqual([
      undefined,
      'active',
      'paused',
    ]);
    expect(history.map((event) => event.actor)).toEqual([SYSTEM, OWNER, OWNER]);
    expect(history.map((event) => event.occurredAt)).toEqual([
      source.createdAt,
      paused.updatedAt,
      retired.updatedAt,
    ]);
  });

  it('share the correlation id of their transaction', async () => {
    const [first, second] = [newSource(), newSource()];
    await db.transaction(
      async ({ repositories }) => {
        await repositories.sources.insert(first);
        await repositories.sources.insert(second);
      },
      { correlationId: 'req-7f3a' },
    );

    const events = [
      ...(await db.events.history({ type: 'source', id: first.id })),
      ...(await db.events.history({ type: 'source', id: second.id })),
    ];
    expect(events.map((event) => event.correlationId)).toEqual(['req-7f3a', 'req-7f3a']);
  });

  it('disappear together with the change when the transaction rolls back', async () => {
    const source = newSource();
    await expect(
      db.transaction(async ({ repositories }) => {
        await repositories.sources.insert(source);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');

    await expect(db.events.history({ type: 'source', id: source.id })).resolves.toEqual([]);
  });

  it('refuse to store an entity at a later version without its earlier ones', async () => {
    const skipped = changeSourceStatus(newSource(), 'paused', ctx(OWNER, 1));
    const error = await db.repositories.sources.insert(skipped).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidWriteError);
    expect(error).toMatchObject({ reason: 'insert_requires_version_1' });
    await expect(db.repositories.sources.getById(skipped.id)).resolves.toBeUndefined();
  });

  it('refuse a malformed correlation id', async () => {
    await expect(
      db.transaction(() => Promise.resolve(), { correlationId: 'has spaces' }),
    ).rejects.toMatchObject({ name: 'InvalidWriteError', reason: 'invalid_correlation_id' });
  });
});

describe('the database guarantees', () => {
  it('reject an entity change without an event (checked at commit)', async () => {
    const source = newSource();
    await db.repositories.sources.insert(source);

    const error = await rejection(() =>
      db.sql.begin(async (tx) => {
        await tx`update sources set trust = 'high', version = version + 1 where id = ${source.id}`;
      }),
    );

    expect(error).toMatchObject({
      kind: 'missing_event',
      constraint: 'sources_requires_event',
      table: 'sources',
    });
    expect((await db.repositories.sources.getById(source.id))?.trust).toBe(source.trust);
  });

  it('reject a new row without an event', async () => {
    const error = await rejection(() =>
      db.sql.begin(async (tx) => {
        await tx`
          insert into decisions (id, subject_type, subject_id, outcome, rationale, created_at,
                                 created_by_type, created_by_id)
          values (${uuidv7()}, 'opportunity', ${uuidv7()}, 'approve', 'Silent', now(), 'owner',
                  'owner')
        `;
      }),
    );
    expect(error).toMatchObject({ kind: 'missing_event', constraint: 'decisions_requires_event' });
  });

  it('never rewrite or remove an event', async () => {
    const source = newSource();
    await db.repositories.sources.insert(source);

    const updated = await rejection(
      () => db.sql`update events set actor_id = 'someone' where aggregate_id = ${source.id}`,
    );
    const deleted = await rejection(
      () => db.sql`delete from events where aggregate_id = ${source.id}`,
    );
    const truncated = await rejection(() => db.sql`truncate events`);

    expect(updated).toMatchObject({
      kind: 'forbidden_change',
      constraint: 'events_update_forbidden',
    });
    expect(deleted).toMatchObject({
      kind: 'forbidden_change',
      constraint: 'events_delete_forbidden',
    });
    expect(truncated).toMatchObject({ kind: 'forbidden_change' });
  });

  it('keep exactly one event per version', async () => {
    const source = newSource();
    await db.repositories.sources.insert(source);

    const error = await rejection(
      () => db.sql`
        insert into events (id, type, aggregate_type, aggregate_id, aggregate_version, occurred_at,
                            actor_type, actor_id, payload)
        values (${uuidv7()}, 'source.created', 'source', ${source.id}, 1, now(), 'agent', 'a',
                ${db.sql.json({ snapshot: {} })})
      `,
    );
    expect(error).toMatchObject({ kind: 'unique', constraint: 'events_aggregate_version_key' });
  });

  it('reject an event whose type does not match its aggregate or version', async () => {
    const insertEvent = (type: string, version: number) =>
      db.sql`
        insert into events (id, type, aggregate_type, aggregate_id, aggregate_version, occurred_at,
                            actor_type, actor_id, payload)
        values (${uuidv7()}, ${type}, 'source', ${uuidv7()}, ${version}, now(), 'agent', 'a',
                ${db.sql.json({ snapshot: {} })})
      `;

    await expect(rejection(() => insertEvent('signal.created', 1))).resolves.toMatchObject({
      constraint: 'events_type_matches_aggregate',
    });
    await expect(rejection(() => insertEvent('source.created', 2))).resolves.toMatchObject({
      constraint: 'events_type_matches_aggregate',
    });
  });
});

describe('events.list', () => {
  it('returns the events of a period in recording order, page by page', async () => {
    const early = sourceAt('2030-01-01T08:00:00.000Z');
    const late = sourceAt('2030-01-01T20:00:00.000Z');
    const nextDay = sourceAt('2030-01-02T08:00:00.000Z');
    for (const source of [early, late, nextDay]) await db.repositories.sources.insert(source);
    const day = {
      from: toTimestamp(new Date('2030-01-01T00:00:00.000Z')),
      to: toTimestamp(new Date('2030-01-02T00:00:00.000Z')),
    };

    const all = await db.events.list(day);
    const firstPage = await db.events.list({ ...day, limit: 1 });
    const secondPage = await db.events.list({ ...day, limit: 1, after: firstPage[0]?.position });

    expect(all.map((event) => event.aggregate.id)).toEqual([early.id, late.id]);
    expect(firstPage.map((event) => event.aggregate.id)).toEqual([early.id]);
    expect(secondPage.map((event) => event.aggregate.id)).toEqual([late.id]);
    expect(
      all.every((event, index) => index === 0 || event.position > (all[index - 1]?.position ?? 0)),
    ).toBe(true);
  });

  it('filters by entity type', async () => {
    const events = await db.events.list({ aggregateType: 'decision' });
    expect(events.every((event) => event.aggregate.type === 'decision')).toBe(true);
  });
});

describe('database.command (idempotency)', () => {
  it('runs a command once and gives a repeat the stored result', async () => {
    const key = `tg-callback-${uuidv7()}`;
    let runs = 0;
    const approve = () =>
      db.command(
        { name: 'source.pause', idempotencyKey: key, correlationId: 'tg-update-42' },
        async ({ repositories }) => {
          runs += 1;
          const source = newSource();
          await repositories.sources.insert(source);
          return { sourceId: source.id };
        },
      );

    const first = await approve();
    const second = await approve();

    expect(first.outcome).toBe('executed');
    expect(second).toEqual({ outcome: 'duplicate', result: first.result });
    expect(runs).toBe(1);
    const [event] = await db.events.history({ type: 'source', id: first.result.sourceId });
    expect(event?.correlationId).toBe('tg-update-42');
  });

  it('runs once when duplicates arrive at the same time', async () => {
    const key = `tg-callback-${uuidv7()}`;
    const created: string[] = [];
    const run = () =>
      db.command({ name: 'source.create', idempotencyKey: key }, async ({ repositories }) => {
        const source = newSource();
        await repositories.sources.insert(source);
        created.push(source.id);
        return source.id;
      });

    const results = await Promise.all([run(), run(), run()]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      'duplicate',
      'duplicate',
      'executed',
    ]);
    expect(new Set(results.map((result) => result.result)).size).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('lets a failed command run again with the same key', async () => {
    const key = `tg-callback-${uuidv7()}`;
    await expect(
      db.command({ name: 'source.create', idempotencyKey: key }, () =>
        Promise.reject(new Error('provider down')),
      ),
    ).rejects.toThrow('provider down');

    await expect(
      db.command({ name: 'source.create', idempotencyKey: key }, () => Promise.resolve('done')),
    ).resolves.toEqual({ outcome: 'executed', result: 'done' });
  });

  it('refuses a key that another command already used', async () => {
    const key = `tg-callback-${uuidv7()}`;
    await db.command({ name: 'source.create', idempotencyKey: key }, () => Promise.resolve(1));

    await expect(
      db.command({ name: 'reward.approve', idempotencyKey: key }, () => Promise.resolve(2)),
    ).rejects.toMatchObject({ name: 'InvalidWriteError', reason: 'idempotency_key_reused' });
  });

  it('refuses a malformed key', async () => {
    await expect(
      db.command({ name: 'source.create', idempotencyKey: 'no spaces allowed' }, () =>
        Promise.resolve(1),
      ),
    ).rejects.toMatchObject({ name: 'InvalidWriteError', reason: 'invalid_idempotency_key' });
  });

  it('stores the result only once', async () => {
    const key = `tg-callback-${uuidv7()}`;
    await db.command({ name: 'source.create', idempotencyKey: key }, () => Promise.resolve('ok'));

    const error = await rejection(
      () => db.sql`update idempotency_keys set result = '"changed"' where key = ${key}`,
    );
    expect(error).toMatchObject({
      kind: 'forbidden_change',
      constraint: 'idempotency_keys_update_forbidden',
    });
  });
});
