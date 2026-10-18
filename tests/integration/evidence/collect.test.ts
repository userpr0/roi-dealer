import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureAccessRequest } from '@roi-dealer/command-center';
import { ConstraintViolationError, translateError, type Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  createEvidence,
  evidenceIdSchema,
  pauseSystem,
  resumeSystem,
  revokePrincipal,
  sourceSnapshotIdSchema,
  toTimestamp,
  type Actor,
  type SystemControl,
} from '@roi-dealer/domain';
import {
  collectEvidence,
  connectableEntry,
  createHackerNewsConnector,
  ensureConnection,
  integrationActor,
  MAX_EXCERPT_LENGTH,
  SOURCE_CATALOG,
  type CatalogEntry,
  type SourceConnector,
} from '@roi-dealer/evidence';
import { uuidv7 } from '@roi-dealer/shared';
import { OWNER } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { startFakeHackerNews, type FakeHackerNews } from '../../support/fake-hacker-news.js';
import { createCapturingLogger } from '../../support/logger.js';

const HACKER_NEWS: Actor = { type: 'integration', id: 'source:hacker-news' };
const HOUR_S = 3_600;

let test: TestDatabase;
let db: Database;
let hn: FakeHackerNews;
let connector: SourceConnector;
const { logger } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  hn = await startFakeHackerNews();
  connector = createHackerNewsConnector({ baseUrl: hn.baseUrl, requestTimeoutMs: 2_000 });
});

afterAll(async () => {
  await hn.close();
  await test.drop();
});

beforeEach(() => {
  hn.failWith(undefined);
});

const deps = (extra: { catalog?: readonly CatalogEntry[]; now?: () => number } = {}) => ({
  database: db,
  logger,
  ensureAccess: ensureAccessRequest,
  ...extra,
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

async function grant(actor: Actor): Promise<void> {
  const principal = await db.repositories.principals.getByActor(actor);
  if (principal === undefined) throw new Error(`no principal for ${actor.id}`);
  await db.repositories.principals.update(
    approvePrincipal(principal, { actor: OWNER, at: now() }),
    OWNER,
  );
}

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = (await db.repositories.systemControls.getById(
    AUTOMATION_CONTROL_ID,
  )) as SystemControl;
  const next = paused
    ? pauseSystem(control, 'Тест стоп-крана', { actor: OWNER, at: now() })
    : resumeSystem(control, { actor: OWNER, at: now() });
  await db.repositories.systemControls.update(next, OWNER);
}

/** A copy of the Hacker News entry under another key, for flows that change its state. */
function testEntry(key: string): CatalogEntry {
  return { ...connectableEntry('hacker-news'), key, name: `Test ${key}` };
}

const sinceHoursAgo = (hours: number) => Math.floor(Date.now() / 1_000) - hours * HOUR_S;

describe('the catalog comes first (§2.21)', () => {
  it('refuses sources outside the catalog or not allowed, without a single request', async () => {
    await expect(
      collectEvidence({ ...connector, catalogKey: 'unknown-forum' }, deps()),
    ).rejects.toMatchObject({ code: 'not_cataloged' });
    await expect(
      collectEvidence({ ...connector, catalogKey: 'reddit' }, deps()),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(ensureConnection('reddit', deps())).rejects.toMatchObject({ code: 'not_allowed' });
    expect(hn.requests).toEqual([]);
  });
});

describe('connecting Hacker News', () => {
  it('asks the owner in /decisions and fetches nothing before the grant', async () => {
    const connection = await ensureConnection('hacker-news', deps());
    expect(connection.access).toBe('requested');
    expect(connection.source).toMatchObject({
      catalogKey: 'hacker-news',
      kind: 'forum',
      status: 'active',
      createdBy: { type: 'system', id: 'evidence-engine' },
    });

    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Hacker News');
    expect(request?.summary).toContain('Без ников, профилей и контактов');
    expect((await db.repositories.principals.getByActor(HACKER_NEWS))?.status).toBe('pending');

    const again = await ensureConnection('hacker-news', deps());
    expect(again).toMatchObject({ access: 'waiting', source: { id: connection.source.id } });
    expect(
      (await db.repositories.approvalRequests.listByStatus('pending')).filter(
        (item) => item.kind === 'access_grant',
      ),
    ).toHaveLength(1);

    await expect(collectEvidence(connector, deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'access_not_active',
    });
    expect(hn.requests).toEqual([]);
  });

  it('collects redacted evidence with provenance once the owner granted access', async () => {
    hn.publish([
      {
        id: 101,
        type: 'story',
        by: 'jane_doe_author',
        time: sinceHoursAgo(2),
        title: 'Ask HN: How do you chase unpaid invoices?',
        text:
          'I&#x27;m a freelancer and clients pay 60 days late.<p>Email me at jane@example.com ' +
          'or call (555) 123-4567. More on twitter.com/janedoe',
      },
      { id: 102, type: 'story', by: 'someone', time: sinceHoursAgo(1), title: 'Dead', dead: true },
      { id: 103, deleted: true },
      { id: 104, type: 'comment', by: 'someone', time: sinceHoursAgo(1), text: 'A comment' },
      {
        id: 105,
        type: 'story',
        by: 'long_writer',
        time: sinceHoursAgo(1),
        title: 'Ask HN: Long post',
        text: 'word '.repeat(600),
      },
    ]);
    await grant(HACKER_NEWS);

    const outcome = await collectEvidence(connector, deps());
    expect(outcome).toMatchObject({ status: 'collected', itemCount: 5, evidenceCount: 2 });
    if (outcome.status !== 'collected') throw new Error('not collected');
    expect(outcome.redactions).toBe(3);

    const snapshot = await db.repositories.sourceSnapshots.getById(outcome.snapshotId);
    const source = await db.repositories.sources.getByCatalogKey('hacker-news');
    expect(snapshot).toMatchObject({
      sourceId: source?.id,
      requestUrl: `${hn.baseUrl}/askstories.json`,
      itemCount: 5,
      evidenceCount: 2,
      createdBy: HACKER_NEWS,
      contentSha256: createHash('sha256').update(hn.bodies.join('')).digest('hex'),
    });

    const rows = await db.sql<{ id: string; external_id: string }[]>`
      select id, external_id from evidence where snapshot_id = ${outcome.snapshotId}
      order by external_id
    `;
    expect(rows.map((row) => row.external_id)).toEqual(['101', '105']);
    const [first, long] = await db.repositories.evidence.getByIds(
      rows.map((row) => evidenceIdSchema.parse(row.id)),
    );
    expect(first).toMatchObject({
      kind: 'post',
      url: 'https://news.ycombinator.com/item?id=101',
      language: 'en',
      snapshotId: outcome.snapshotId,
      createdBy: HACKER_NEWS,
    });
    expect(first?.excerpt).toBe(
      "Ask HN: How do you chase unpaid invoices?\n\nI'm a freelancer and clients pay 60 days " +
        'late.\n\nEmail me at [email] or call [phone]. More on [profile]',
    );
    expect(first).not.toHaveProperty('market');
    expect(long?.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
    expect(long?.excerpt.length).toBeGreaterThan(MAX_EXCERPT_LENGTH - 10);
    expect(long?.excerpt.endsWith('…')).toBe(true);

    // Nothing that identifies a person is stored anywhere, events included.
    const stored = JSON.stringify([
      await db.sql`select * from evidence`,
      await db.sql`select * from source_snapshots`,
      await db.sql`select payload from events`,
    ]);
    for (const personal of ['jane_doe_author', 'jane@example.com', '123-4567', 'janedoe']) {
      expect(stored).not.toContain(personal);
    }

    const history = await db.events.history({ type: 'evidence', id: rows[0]?.id ?? '' });
    expect(history[0]).toMatchObject({
      actor: HACKER_NEWS,
      correlationId: `evidence-collect-${outcome.snapshotId}`,
    });
  });

  it('never stores an item twice and asks only for new ones', async () => {
    hn.publish(
      [{ id: 106, type: 'story', by: 'x', time: sinceHoursAgo(0), title: 'Ask HN: New one' }],
      [106, 101, 102, 103, 104, 105],
    );
    const before = hn.requests.length;
    await expect(collectEvidence(connector, deps())).resolves.toMatchObject({
      status: 'collected',
      itemCount: 1,
      evidenceCount: 1,
    });
    expect(hn.requests.slice(before)).toEqual(['/v0/askstories.json', '/v0/item/106.json']);
    await expect(collectEvidence(connector, deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'nothing_new',
    });
  });

  it('skips an item that cannot be stored and keeps the rest of the load', async () => {
    const { logger: captured, records } = createCapturingLogger('worker');
    const stub: SourceConnector = {
      catalogKey: 'hacker-news',
      fetch: () =>
        Promise.resolve({
          requestUrl: `${hn.baseUrl}/askstories.json`,
          contentSha256: 'c'.repeat(64),
          itemCount: 2,
          items: [
            { externalId: 'bad id', kind: 'post', text: 'Invalid id', observedAt: now() },
            { externalId: 'stub-1', kind: 'post', text: 'A valid post', observedAt: now() },
          ],
        }),
    };
    await expect(collectEvidence(stub, { database: db, logger: captured })).resolves.toMatchObject({
      status: 'collected',
      itemCount: 2,
      evidenceCount: 1,
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'evidence item skipped',
        reason: 'invariant_violation',
      }),
    );
    expect(JSON.stringify(records)).not.toContain('Invalid id');
  });

  it('stops at the kill switch before any request', async () => {
    await setKillSwitch(true);
    const before = hn.requests.length;
    try {
      await expect(collectEvidence(connector, deps())).rejects.toMatchObject({
        code: 'automation_paused',
      });
      await expect(ensureConnection('hacker-news', deps())).rejects.toMatchObject({
        code: 'automation_paused',
      });
      expect(hn.requests.length).toBe(before);
    } finally {
      await setKillSwitch(false);
    }
  });

  it('reports a failing source and stores nothing', async () => {
    const snapshots = await db.sql`select id from source_snapshots`;
    hn.failWith(503);
    await expect(collectEvidence(connector, deps())).rejects.toMatchObject({
      code: 'fetch_failed',
      details: expect.objectContaining({ status: 503 }) as unknown,
    });
    expect(await db.sql`select id from source_snapshots`).toHaveLength(snapshots.length);
  });
});

describe('the owner’s answer', () => {
  it('retires the source when the owner refuses access', async () => {
    const entry = testEntry('refused-forum');
    const catalog = [...SOURCE_CATALOG, entry];
    await ensureConnection(entry.key, deps({ catalog }));
    const principal = await db.repositories.principals.getByActor(integrationActor(entry));
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      revokePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );

    const connection = await ensureConnection(entry.key, deps({ catalog }));
    expect(connection).toMatchObject({ access: 'revoked', source: { status: 'retired' } });
    await expect(
      collectEvidence({ ...connector, catalogKey: entry.key }, deps({ catalog })),
    ).resolves.toEqual({ status: 'skipped', reason: 'source_inactive' });
  });

  it('asks again when the request expired unanswered', async () => {
    const entry = testEntry('slow-forum');
    const catalog = [...SOURCE_CATALOG, entry];
    const start = Date.now();
    expect((await ensureConnection(entry.key, deps({ catalog, now: () => start }))).access).toBe(
      'requested',
    );
    const later = start + 8 * 24 * HOUR_S * 1_000;
    expect((await ensureConnection(entry.key, deps({ catalog, now: () => later }))).access).toBe(
      'renewed',
    );
    const requests = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (request) => request.title === `Доступ: ${entry.name}`,
    );
    expect(requests).toHaveLength(2);
  });
});

describe('the database guards provenance and privacy (migration 0005)', () => {
  it('rejects an email in an excerpt, a repeated item and a snapshot of another source', async () => {
    const source = await db.repositories.sources.getByCatalogKey('hacker-news');
    if (source === undefined) throw new Error('no source');
    const [row] = await db.sql<{ id: string; external_id: string; snapshot_id: string }[]>`
      select id, external_id, snapshot_id from evidence where source_id = ${source.id} limit 1
    `;

    await expect(
      rejection(
        () => db.sql`update evidence set excerpt = 'mail a@b.io' where id = ${row?.id ?? ''}`,
      ),
    ).resolves.toMatchObject({ kind: 'forbidden_change' });
    await expect(
      rejection(
        () => db.sql`
          insert into evidence (id, source_id, kind, excerpt, observed_at, created_at,
                                created_by_type, created_by_id)
          values (${uuidv7()}, ${source.id}, 'post', 'mail a@b.io', now(), now(), 'system', 'test')
        `,
      ),
    ).resolves.toMatchObject({ kind: 'check', constraint: 'evidence_excerpt_without_email' });

    const duplicate = createEvidence(
      {
        sourceId: source.id,
        kind: 'post',
        excerpt: 'The same item again',
        observedAt: now(),
        externalId: row?.external_id ?? '',
      },
      { id: evidenceIdSchema.parse(uuidv7()), actor: HACKER_NEWS, at: now() },
    );
    await expect(
      rejection(() => db.repositories.evidence.insert(duplicate)),
    ).resolves.toMatchObject({ kind: 'unique', constraint: 'evidence_source_external_key' });

    const other = (await db.repositories.sources.getByCatalogKey('refused-forum'))?.id;
    const foreign = createEvidence(
      {
        sourceId: other ?? source.id,
        kind: 'post',
        excerpt: 'Claims a load of another source',
        observedAt: now(),
        snapshotId: sourceSnapshotIdSchema.parse(row?.snapshot_id),
      },
      { id: evidenceIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
    );
    await expect(rejection(() => db.repositories.evidence.insert(foreign))).resolves.toMatchObject({
      kind: 'foreign_key',
      constraint: 'evidence_snapshot_same_source',
    });

    await expect(rejection(() => db.sql`delete from source_snapshots`)).resolves.toMatchObject({
      kind: 'forbidden_change',
    });
  });
});
