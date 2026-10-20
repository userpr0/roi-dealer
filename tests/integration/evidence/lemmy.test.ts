import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureAccessRequest } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import { approvePrincipal, toTimestamp, type Actor } from '@roi-dealer/domain';
import {
  collectEvidence,
  connectableEntry,
  createLemmyConnector,
  ensureConnection,
  LEMMY_COMMUNITIES,
  type FetchRequest,
} from '@roi-dealer/evidence';
import { OWNER } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { startFakeLemmy, type FakeLemmy } from '../../support/fake-lemmy.js';
import { createCapturingLogger } from '../../support/logger.js';

const LEMMY: Actor = { type: 'integration', id: 'source:lemmy-world' };

let test: TestDatabase;
let db: Database;
let lemmy: FakeLemmy;
const { logger, records } = createCapturingLogger('worker');

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  lemmy = await startFakeLemmy();
});

afterAll(async () => {
  await lemmy.close();
  await test.drop();
});

beforeEach(() => {
  lemmy.failWith(undefined);
});

const request = (overrides: Partial<FetchRequest> = {}): FetchRequest => ({
  maxItems: 30,
  known: () => Promise.resolve(new Set<string>()),
  ...overrides,
});

describe('the Lemmy connector (05b)', () => {
  const connector = () => createLemmyConnector({ baseUrl: lemmy.baseUrl, requestTimeoutMs: 2_000 });

  it('reads the newest posts of its communities and keeps only usable lemmy.world posts', async () => {
    lemmy.publish([
      {
        id: 101,
        community: 'asklemmy',
        name: 'How do you keep track of client invoices?',
        body: 'Spreadsheets keep failing me.',
        published: '2026-10-20T15:58:30.395455Z',
        creator: 'alice_writes',
      },
      { id: 102, community: 'asklemmy', name: 'Copy from another server', local: false },
      { id: 103, community: 'nostupidquestions', name: 'Deleted one', deleted: true },
      { id: 104, community: 'nostupidquestions', name: 'Removed one', removed: true },
      { id: 105, community: 'selfhosted', name: 'Adult one', nsfw: true },
      { id: 106, community: 'selfhosted', name: 'Auf Deutsch', languageId: 31 },
      {
        id: 107,
        community: 'selfhosted',
        name: 'Backups for a small office?',
        body: null,
        languageId: 0,
      },
      { id: 108, community: 'memes', name: 'Not one of our communities' },
    ]);

    const run = await connector().fetch(request());

    expect(lemmy.requests).toEqual(
      LEMMY_COMMUNITIES.map(
        (community) => `/api/v3/post/list?community_name=${community}&sort=New&limit=20`,
      ),
    );
    expect(run.requestUrl).toBe(
      `${lemmy.baseUrl}/post/list?community_name=asklemmy&sort=New&limit=20`,
    );
    expect(run.itemCount).toBe(7);
    expect(run.items).toEqual([
      {
        externalId: '101',
        kind: 'post',
        text: 'How do you keep track of client invoices?\n\nSpreadsheets keep failing me.',
        url: `${lemmy.baseUrl.replace('/api/v3', '')}/post/101`,
        observedAt: toTimestamp(new Date('2026-10-20T15:58:30.395Z')),
        language: 'en',
      },
      expect.objectContaining({ externalId: '107', text: 'Backups for a small office?' }),
    ]);
    // The author is never read.
    expect(JSON.stringify(run)).not.toContain('alice_writes');
    const hash = createHash('sha256');
    for (const body of lemmy.bodies) hash.update(body);
    expect(run.contentSha256).toBe(hash.digest('hex'));
  });

  it('skips stored posts and stops at the load limit', async () => {
    const run = await connector().fetch(
      request({
        maxItems: 1,
        known: (ids) => Promise.resolve(new Set(ids.filter((id) => id === '101'))),
      }),
    );
    expect(run.items.map((item) => item.externalId)).toEqual(['107']);

    const none = await connector().fetch(request({ maxItems: 0 }));
    expect(none.items).toEqual([]);
  });

  it('reports a failing source', async () => {
    lemmy.failWith(503);
    await expect(connector().fetch(request())).rejects.toMatchObject({ code: 'fetch_failed' });
    lemmy.failWith(undefined);
    await expect(
      createLemmyConnector({ baseUrl: 'http://127.0.0.1:9', requestTimeoutMs: 500 }).fetch(
        request(),
      ),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
    await expect(
      createLemmyConnector({ baseUrl: `${lemmy.baseUrl}/nothing`, requestTimeoutMs: 2_000 }).fetch(
        request(),
      ),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
  });
});

describe('collecting Lemmy through the engine (05b)', () => {
  it('asks the owner first, then stores redacted posts without authors', async () => {
    const deps = { database: db, logger, ensureAccess: ensureAccessRequest };
    const connector = createLemmyConnector({ baseUrl: lemmy.baseUrl, requestTimeoutMs: 2_000 });
    expect(connectableEntry('lemmy-world').key).toBe('lemmy-world');

    const requestsBefore = lemmy.requests.length;
    const connection = await ensureConnection('lemmy-world', deps);
    expect(connection.access).toBe('requested');
    await expect(collectEvidence(connector, deps)).resolves.toMatchObject({
      status: 'skipped',
      reason: 'access_not_active',
    });
    expect(lemmy.requests.length).toBe(requestsBefore);

    const principal = await db.repositories.principals.getByActor(LEMMY);
    if (principal === undefined) throw new Error('Lemmy did not ask for access');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: toTimestamp(new Date()) }),
      OWNER,
    );
    lemmy.publish([
      {
        id: 201,
        community: 'asklemmy',
        name: 'Anyone else chasing late invoices?',
        body: 'Email me at chaser@example.com if you found a tool',
        creator: 'bob_the_freelancer',
      },
    ]);

    const outcome = await collectEvidence(connector, deps);
    expect(outcome).toMatchObject({ status: 'collected' });
    const rows = await db.sql<{ excerpt: string; url: string }[]>`
      select e.excerpt, e.url from evidence e
      join sources s on s.id = e.source_id
      where s.catalog_key = 'lemmy-world' and e.external_id = '201'
    `;
    expect(rows).toEqual([
      {
        excerpt: 'Anyone else chasing late invoices?\n\nEmail me at [email] if you found a tool',
        url: `${lemmy.baseUrl.replace('/api/v3', '')}/post/201`,
      },
    ]);
    const stored = JSON.stringify([
      await db.sql`select * from evidence`,
      await db.sql`select * from events`,
    ]);
    for (const personal of ['chaser@example.com', 'bob_the_freelancer']) {
      expect(stored).not.toContain(personal);
      expect(JSON.stringify(records)).not.toContain(personal);
    }
  });
});
