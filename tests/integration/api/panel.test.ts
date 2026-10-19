import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PanelSnapshot } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import { createHealthRegistry } from '@roi-dealer/observability';
import { signInitData } from '@roi-dealer/telegram';
import { createPanelRoute } from '../../../apps/api/src/panel.js';
import { createRouter } from '../../../apps/api/src/router.js';
import { startApiServer, type ApiServer } from '../../../apps/api/src/server.js';
import { approvedOpportunity, runningTest } from '../../support/cycle.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';

const TOKEN = '7000000001:panel-test-token';
const OWNER_TG = 5151;
const ORIGIN = 'https://userpr0.github.io';
const DAY_MS = 86_400_000;

let test: TestDatabase;
let db: Database;
let server: ApiServer;
let url: string;
const { logger, records } = createCapturingLogger('api');

function initData(userId: number, authDateMs = Date.now()): string {
  return signInitData(
    {
      auth_date: String(Math.floor(authDateMs / 1_000)),
      query_id: 'AAEpanel',
      user: JSON.stringify({ id: userId, first_name: 'Test' }),
    },
    TOKEN,
  );
}

function get(authorization?: string, correlationId?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (authorization !== undefined) headers['authorization'] = authorization;
  if (correlationId !== undefined) headers['x-correlation-id'] = correlationId;
  return fetch(`${url}/api/panel`, { headers });
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  const { opportunity } = await approvedOpportunity(db, 'Invoices that get paid');
  await runningTest(db, opportunity, { startedAtMs: Date.now() - 3 * DAY_MS });
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: createRouter({
      health: createHealthRegistry({ service: 'api' }),
      panel: createPanelRoute({
        database: db,
        botToken: TOKEN,
        ownerUserId: OWNER_TG,
        origins: [ORIGIN],
        logger,
      }),
    }),
    logger,
  });
  url = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.close();
  await test.drop();
});

describe('GET /api/panel (PHASE 13, ADR-0008)', () => {
  it('gives the owner the panel from the database, readable only by the Mini App', async () => {
    const response = await get(`tma ${initData(OWNER_TG)}`, 'panel-owner-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const panel = (await response.json()) as PanelSnapshot;
    expect(panel.killSwitch).toEqual({ running: true });
    expect(panel.decisions).toEqual({ requests: 0, opportunities: 0 });
    expect(panel.economics.budgets.map((line) => [line.label, line.limitCents])).toEqual([
      ['Инфраструктура', 2_000],
      ['AI', 5_000],
    ]);
    expect(panel.experiments).toHaveLength(1);
    expect(panel.experiments[0]).toMatchObject({
      number: 1,
      title: 'Invoices that get paid',
      day: 4,
      days: 14,
      overdue: false,
      metric: 'заявки ≥ 20',
      reached: false,
      budgetCents: 5_000,
      stopLossCents: 2_000,
    });
    expect(panel.stats).toMatchObject({
      days: 30,
      recent: { opportunities: 1, opportunitiesInWork: 1, experimentsStarted: 1 },
    });

    const [view] = await db.access.list({ decision: 'allowed' });
    expect(view).toMatchObject({
      channel: 'telegram',
      actorType: 'owner',
      actorId: `telegram:${String(OWNER_TG)}`,
      permission: 'status.read',
      correlationId: 'miniapp-panel-owner-1',
    });
  });

  it('refuses another Telegram account and records the attempt once per 10 minutes', async () => {
    const response = await get(`tma ${initData(9_999)}`, 'panel-stranger-1');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
    // A flood from the same account is refused too, but not written again.
    expect((await get(`tma ${initData(9_999)}`, 'panel-stranger-2')).status).toBe(403);
    await expect(db.access.count({ decision: 'denied' })).resolves.toBe(1);
    const [denied] = await db.access.list({ decision: 'denied' });
    expect(denied).toMatchObject({
      channel: 'telegram',
      actorId: 'telegram:9999',
      permission: 'status.read',
      reason: 'not_owner',
      correlationId: 'miniapp-panel-stranger-1',
    });
  });

  it('refuses forged, stale and missing signatures without logging them', async () => {
    const forged = new URLSearchParams(initData(9_999));
    forged.set('user', JSON.stringify({ id: OWNER_TG, first_name: 'Test' }));
    const stale = initData(OWNER_TG, Date.now() - 2 * DAY_MS);
    const otherBot = signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1_000)),
        user: JSON.stringify({ id: OWNER_TG }),
      },
      '7000000002:another-bot',
    );
    for (const authorization of [
      `tma ${forged.toString()}`,
      `tma ${stale}`,
      `tma ${otherBot}`,
      initData(OWNER_TG),
      undefined,
    ]) {
      const response = await get(authorization);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    }
    expect(records.filter((item) => item['message'] === 'mini app request refused')).toHaveLength(
      5,
    );
    const logged = JSON.stringify(records);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('AAEpanel');
    expect(logged).not.toContain('hash=');
    // Only the owner's view and the stranger's attempt are in the access log.
    await expect(db.access.count()).resolves.toBe(2);
  });

  it('answers the Mini App’s preflight and no other site’s', async () => {
    const preflight = await fetch(`${url}/api/panel`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization');
    await expect(preflight.text()).resolves.toBe('');
    const other = await fetch(`${url}/api/panel`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.status).toBe(403);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});
