import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDigest,
  ensureAccessRequest,
  pulseDigestLine,
  pulseText,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  addDays,
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  resumeSystem,
  toTimestamp,
  type Actor,
} from '@roi-dealer/domain';
import {
  collectPulse,
  createPulseScheduler,
  createUkBankHolidaysCollector,
  createUsFederalHolidaysCollector,
  createWikipediaPageviewsCollector,
  ensureConnection,
} from '@roi-dealer/evidence';
import { OWNER } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { startFakePulseSources, type FakePulseSources } from '../../support/fake-pulse.js';
import { createCapturingLogger } from '../../support/logger.js';

const TODAY = '2026-11-03';
const NOW = Date.parse(`${TODAY}T09:00:00Z`);
const now = () => NOW;
const USER_AGENT = 'roi-dealer/test (owner@example.com)';

let test: TestDatabase;
let db: Database;
let fake: FakePulseSources;
const { logger, records } = createCapturingLogger('worker');

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  fake = await startFakePulseSources();
});

afterAll(async () => {
  await fake.close();
  await test.drop();
});

beforeEach(() => {
  fake.failWith(undefined);
});

async function grant(catalogKey: string): Promise<void> {
  const actor: Actor = { type: 'integration', id: `source:${catalogKey}` };
  const principal = await db.repositories.principals.getByActor(actor);
  if (principal === undefined) throw new Error(`${catalogKey} did not ask for access`);
  if (principal.status === 'active') return;
  await db.repositories.principals.update(
    approvePrincipal(principal, { actor: OWNER, at: toTimestamp(new Date(NOW)) }),
    OWNER,
  );
}

const deps = () => ({ database: db, logger, now, ensureAccess: ensureAccessRequest });

/** A Wikipedia series of 35 days ending yesterday: 28 days at `base`, then 7 at `recent`. */
function views(base: number, recent: number): Record<string, number> {
  const result: Record<string, number> = {};
  const end = addDays(TODAY, -1);
  for (let i = 0; i < 35; i += 1) result[addDays(end, i - 34)] = i < 28 ? base : recent;
  return result;
}

describe('the Pulse journals (05c, migration 0021)', () => {
  it('replaces a value of the same day and updates a known event', async () => {
    await db.pulse.recordPoints([
      {
        catalogKey: 'wikimedia-pageviews',
        series: 'en:Journal_test',
        day: '2026-10-01',
        value: 10,
      },
      {
        catalogKey: 'wikimedia-pageviews',
        series: 'en:Journal_test',
        day: '2026-10-01',
        value: 12,
      },
    ]);
    const points = await db.pulse.points({
      from: '2026-10-01',
      to: '2026-10-01',
      catalogKey: 'wikimedia-pageviews',
    });
    expect(points.filter((point) => point.series === 'en:Journal_test')).toEqual([
      {
        catalogKey: 'wikimedia-pageviews',
        series: 'en:Journal_test',
        day: '2026-10-01',
        value: 12,
      },
    ]);

    const season = {
      catalogKey: 'uk-bank-holidays',
      market: 'GB',
      startsOn: '2027-03-01',
      endsOn: '2027-03-10',
      title: 'Journal test season',
      kind: 'season' as const,
      sourceUrl: 'https://www.gov.uk/bank-holidays',
    };
    await db.pulse.recordEvents([season, { ...season, endsOn: '2027-03-12' }]);
    // A multi-day event shows while it lasts.
    expect(await db.pulse.events({ from: '2027-03-11', to: '2027-03-11' })).toEqual([
      { ...season, endsOn: '2027-03-12' },
    ]);
    await db.sql`delete from calendar_events where title = 'Journal test season'`;
    await db.sql`delete from metric_points where series = 'en:Journal_test'`;
  });

  it('refuses bad values before and in the database', async () => {
    await expect(
      db.pulse.recordEvents([
        {
          catalogKey: 'uk-bank-holidays',
          market: 'GB',
          startsOn: '2027-03-10',
          endsOn: '2027-03-01',
          title: 'Backwards',
          kind: 'holiday',
          sourceUrl: 'https://www.gov.uk/bank-holidays',
        },
      ]),
    ).rejects.toThrow();
    await expect(
      db.pulse.recordPoints([
        { catalogKey: 'wikimedia-pageviews', series: 'en:X', day: '2026-10-01', value: -1 },
      ]),
    ).rejects.toThrow();
    await expect(
      db.sql`insert into calendar_events (catalog_key, market, starts_on, title, kind, source_url)
        values ('uk-bank-holidays', 'GB', '2027-01-01', 'x', 'party', 'https://x.example')`,
    ).rejects.toThrow();
  });
});

describe('the Pulse collectors (05c)', () => {
  it('reads gov.uk bank holidays: upcoming only, regional ones marked, no duplicates', async () => {
    fake.setBankHolidays({
      'england-and-wales': [
        { title: 'Summer bank holiday', date: '2026-08-31' },
        { title: 'Christmas Day', date: '2026-12-25' },
        { title: 'Boxing Day', date: '2026-12-28' },
      ],
      scotland: [
        { title: 'Christmas Day', date: '2026-12-25' },
        { title: 'St Andrew’s Day', date: '2026-11-30' },
      ],
      'northern-ireland': [{ title: 'Christmas Day', date: '2026-12-25' }],
    });
    const load = await createUkBankHolidaysCollector({ baseUrl: fake.govUkUrl }).fetch({
      today: TODAY,
    });
    expect(load.requestUrl).toBe(`${fake.govUkUrl}/bank-holidays.json`);
    expect(load.events?.map((event) => [event.startsOn, event.title])).toEqual([
      ['2026-12-25', 'Christmas Day'],
      ['2026-12-28', 'Boxing Day'],
      ['2026-11-30', 'St Andrew’s Day (Scotland)'],
    ]);
    expect(load.events?.every((event) => event.market === 'GB' && event.kind === 'holiday')).toBe(
      true,
    );
  });

  it('lists OPM federal holidays from today on, with no request', async () => {
    const load = await createUsFederalHolidaysCollector().fetch({ today: TODAY });
    expect(load.events?.slice(0, 3).map((event) => [event.startsOn, event.title])).toEqual([
      ['2026-11-11', 'Veterans Day'],
      ['2026-11-26', 'Thanksgiving Day'],
      ['2026-12-25', 'Christmas Day'],
    ]);
    expect(load.events?.every((event) => event.startsOn >= TODAY)).toBe(true);
  });

  it('reads Wikipedia views with the User-Agent, one article after another', async () => {
    fake.setPageviews({ Tax_return: views(100, 250) });
    const before = fake.requests.length;
    const load = await createWikipediaPageviewsCollector({
      baseUrl: fake.wikimediaUrl,
      articles: ['Tax return', 'No such article'],
      userAgent: USER_AGENT,
    }).fetch({ today: TODAY });
    expect(fake.requests.slice(before)).toEqual([
      '/wiki/metrics/pageviews/per-article/en.wikipedia/all-access/user/Tax_return/daily/2026092400/2026110200',
      '/wiki/metrics/pageviews/per-article/en.wikipedia/all-access/user/No_such_article/daily/2026092400/2026110200',
    ]);
    expect(fake.userAgents.slice(-2)).toEqual([USER_AGENT, USER_AGENT]);
    // The missing article (404) is skipped, not an error.
    expect(load.points).toHaveLength(35);
    expect(load.points?.at(-1)).toEqual({
      catalogKey: 'wikimedia-pageviews',
      series: 'en:Tax_return',
      day: '2026-11-02',
      value: 250,
    });
  });

  it('reports a failing source', async () => {
    fake.failWith(503);
    await expect(
      createUkBankHolidaysCollector({ baseUrl: fake.govUkUrl }).fetch({ today: TODAY }),
    ).rejects.toMatchObject({ code: 'fetch_failed' });
  });
});

describe('collecting the Pulse through the engine (05c)', () => {
  it('asks the owner first, stores after the grant, and stops with the kill switch', async () => {
    fake.setBankHolidays({ 'england-and-wales': [{ title: 'Christmas Day', date: '2026-12-25' }] });
    const uk = createUkBankHolidaysCollector({ baseUrl: fake.govUkUrl });

    const connection = await ensureConnection('uk-bank-holidays', deps());
    expect(connection.access).toBe('requested');
    const before = fake.requests.length;
    await expect(collectPulse(uk, deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'access_not_active',
    });
    expect(fake.requests.length).toBe(before);

    await grant('uk-bank-holidays');
    await expect(collectPulse(uk, deps())).resolves.toEqual({
      status: 'collected',
      points: 0,
      events: 1,
    });
    expect(await db.pulse.events({ from: '2026-12-25', to: '2026-12-25' })).toEqual([
      expect.objectContaining({ market: 'GB', title: 'Christmas Day', kind: 'holiday' }),
    ]);

    const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    if (control === undefined) throw new Error('kill switch missing');
    const paused = pauseSystem(control, 'test', { actor: OWNER, at: toTimestamp(new Date()) });
    await db.repositories.systemControls.update(paused, OWNER);
    try {
      await expect(collectPulse(uk, deps())).rejects.toMatchObject({ code: 'automation_paused' });
    } finally {
      await db.repositories.systemControls.update(
        resumeSystem(paused, { actor: OWNER, at: toTimestamp(new Date()) }),
        OWNER,
      );
    }
  });

  it('runs every collector on its scheduler and shows the result in /pulse and the digest', async () => {
    fake.setPageviews({ Tax_return: views(100, 250), Bookkeeping: views(80, 80) });
    const collectors = [
      createUsFederalHolidaysCollector(),
      createWikipediaPageviewsCollector({
        baseUrl: fake.wikimediaUrl,
        articles: ['Tax_return', 'Bookkeeping'],
        userAgent: USER_AGENT,
      }),
    ];
    const scheduler = createPulseScheduler({
      ...deps(),
      collectors,
      intervalMs: 60_000,
    });
    // First run: each source asks for access; second run after the grants: collected.
    await scheduler.runOnce();
    await grant('us-federal-holidays');
    await grant('wikimedia-pageviews');
    const again = createPulseScheduler({ ...deps(), collectors, intervalMs: 60_000 });
    await again.runOnce();

    const text = await pulseText(db, NOW);
    expect(text).toContain('🔜 Пульс на 6 недель (до 15.12): US, GB, CA, AU');
    expect(text).toContain('• 11.11 · US · Veterans Day');
    expect(text).toContain('• 26.11 · US · Thanksgiving Day');
    expect(text).toContain('• Tax return — 📈 растёт ×2.50 (250 в день)');
    expect(text).toContain('• Bookkeeping — ➖ ровно ×1.00');
    expect(text.indexOf('Tax return')).toBeLessThan(text.indexOf('Bookkeeping'));
    expect(text.length).toBeLessThan(4_096);

    const line = await pulseDigestLine(db, NOW);
    expect(line).toBe('🔜 Пульс: растут: Tax return → /pulse');
    expect(await buildDigest(db, NOW)).toContain(line ?? '');
    // The owner's public contact never reaches the logs.
    expect(JSON.stringify(records)).not.toContain('owner@example.com');
  });

  it('says where to set up what is missing', async () => {
    const empty = await createTestDatabase();
    try {
      const text = await pulseText(empty.database, NOW);
      expect(text).toContain('Пока пусто: источники праздников ждут доступа в /decisions.');
      expect(text).toContain('PULSE_WIKIPEDIA_ARTICLES и PUBLIC_CONTACT_EMAIL у worker');
      expect(await pulseDigestLine(empty.database, NOW)).toBeUndefined();
    } finally {
      await empty.drop();
    }
  });
});
