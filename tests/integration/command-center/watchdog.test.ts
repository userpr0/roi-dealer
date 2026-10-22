import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiKeyFixedText,
  aiKeyText,
  buildDigest,
  createCommandCenter,
  createServiceWatchdog,
  recoveredText,
  requestAccess,
  SETUP_COMPLETE_TEXT,
  setupStatus,
  silentText,
  versionFixedText,
  versionText,
} from '@roi-dealer/command-center';
import {
  createServiceHeartbeat,
  type Database,
  type ServiceName,
  type ServiceSetup,
} from '@roi-dealer/database';
import {
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  resolveApprovalRequest,
  resumeSystem,
  timestampMs,
  toTimestamp,
  type SystemControl,
  type Timestamp,
} from '@roi-dealer/domain';
import { at, OWNER } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';

const MINUTE = 60_000;
const BOT_VERSION = 'abc1234';

let test: TestDatabase;
let db: Database;
let clock = timestampMs(at(600));
const now = () => clock;
const stamp = (ms: number): Timestamp => toTimestamp(new Date(ms));
const { logger } = createCapturingLogger('bot');
let notices: string[] = [];
const deliver = (text: string) => {
  notices.push(text);
  return Promise.resolve();
};

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
});

afterAll(async () => {
  await test.drop();
});

beforeEach(async () => {
  notices = [];
  await db.sql`delete from service_incidents`;
  await db.sql`delete from service_heartbeats`;
});

function mark(
  service: ServiceName,
  ageMinutes: number,
  options: { version?: string; setup?: ServiceSetup } = {},
) {
  const seenAt = stamp(clock - ageMinutes * MINUTE);
  return db.services.beat({
    service,
    version: options.version ?? BOT_VERSION,
    startedAt: stamp(clock - (ageMinutes + 60) * MINUTE),
    setup: options.setup ?? {},
    at: seenAt,
  });
}

function watchdog(startedAgoMinutes = 60, version = BOT_VERSION) {
  return createServiceWatchdog({
    database: db,
    logger,
    deliver,
    version,
    startedAtMs: clock - startedAgoMinutes * MINUTE,
    now,
  });
}

describe('service heartbeats (13c)', () => {
  it('keep one row per service with its version and setup, names and switches only', async () => {
    const timer = createServiceHeartbeat({
      watch: db.services,
      service: 'worker',
      version: 'def5678',
      setup: { ai: ['anthropic', 'openai'] },
      logger,
      now,
    });
    timer.start();
    await timer.stop();
    await mark('api', 0, { setup: { panel: true, form: false, payments: false } });
    await mark('api', 0, { setup: { panel: true, form: true, payments: false } });

    const rows = await db.services.heartbeats();
    expect(rows.map((row) => [row.service, row.version, row.setup])).toEqual([
      ['api', BOT_VERSION, { panel: true, form: true, payments: false }],
      ['worker', 'def5678', { ai: ['anthropic', 'openai'] }],
    ]);
    const worker = rows.find((row) => row.service === 'worker');
    expect(timestampMs(worker?.seenAt ?? stamp(0))).toBeGreaterThanOrEqual(
      timestampMs(worker?.startedAt ?? stamp(0)),
    );

    // Values never go into the setup: no addresses, keys or free text.
    await expect(
      db.services.beat({
        service: 'api',
        version: BOT_VERSION,
        startedAt: stamp(clock),
        setup: { email: ['owner@example.com'] },
      }),
    ).rejects.toThrow();
    await expect(
      db.services.beat({
        service: 'api',
        version: 'v 1; drop',
        startedAt: stamp(clock),
        setup: {},
      }),
    ).rejects.toThrow();
  });

  it('only logs a mark that could not be written', async () => {
    const { logger: capturing, records } = createCapturingLogger('worker');
    const timer = createServiceHeartbeat({
      watch: { beat: () => Promise.reject(new Error('database is down')) },
      service: 'worker',
      version: 'dev',
      setup: {},
      logger: capturing,
    });
    timer.start();
    await timer.stop();
    expect(records.map((record) => record.message)).toEqual(['service heartbeat not recorded']);
  });
});

describe('the watchdog (13c)', () => {
  it('reports a silent service once and its recovery once', async () => {
    await mark('worker', 11);
    await mark('api', 1);
    const dog = watchdog();

    expect(await dog.runOnce()).toBe(1);
    expect(notices).toEqual([silentText('worker', stamp(clock - 11 * MINUTE), clock)]);
    expect(notices[0]).toContain('🔴 worker молчит 11 мин');
    expect(await dog.runOnce()).toBe(0);

    clock += 5 * MINUTE;
    await mark('worker', 0);
    expect(await dog.runOnce()).toBe(1);
    expect(notices[1]).toBe(recoveredText('worker', stamp(clock - 16 * MINUTE), clock));
    expect(notices[1]).toContain('🟢 worker снова работает (молчал около 16 мин)');
    expect(await dog.runOnce()).toBe(0);
    expect(await db.services.openIncidents()).toEqual([]);
  });

  it('opens nothing when the notice could not be delivered, and retries', async () => {
    await mark('api', 30);
    const failing = createServiceWatchdog({
      database: db,
      logger,
      deliver: () => Promise.reject(new Error('telegram is down')),
      version: BOT_VERSION,
      startedAtMs: clock - 60 * MINUTE,
      now,
    });
    await expect(failing.runOnce()).rejects.toThrow('telegram is down');
    expect(await db.services.openIncidents()).toEqual([]);
    expect(await watchdog().runOnce()).toBe(1);
    expect(notices[0]).toContain('🔴 api молчит 30 мин');
  });

  it('reports services left on another version after the grace period', async () => {
    await mark('worker', 1, { version: 'old0000' });
    await mark('api', 1);

    // Right after the bot's start the services are still being deployed.
    expect(await watchdog(5).runOnce()).toBe(0);
    expect(await watchdog(30).runOnce()).toBe(1);
    expect(notices).toEqual([versionText('worker', 'old0000', BOT_VERSION)]);
    expect(await watchdog(30).runOnce()).toBe(0);

    await mark('worker', 0);
    expect(await watchdog(30).runOnce()).toBe(1);
    expect(notices[1]).toBe(versionFixedText('worker', BOT_VERSION));
    // A local bot without a version compares nothing.
    await mark('worker', 0, { version: 'old0000' });
    expect(await watchdog(30, 'dev').runOnce()).toBe(0);
  });

  it('reports a rejected AI key once and when it works again', async () => {
    const call = {
      task: 'redact-names',
      taskVersion: 1,
      purpose: 'task',
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      latencyMs: 5,
      actorType: 'system',
      actorId: 'evidence-engine',
      provider: 'openai',
      model: 'gpt-5.4-mini',
    } as const;
    for (const minutesAgo of [20, 10]) {
      await db.aiCalls.record({
        ...call,
        occurredAt: stamp(clock - minutesAgo * MINUTE),
        outcome: 'failed',
        failure: 'auth',
      });
    }
    const dog = watchdog();
    expect(await dog.runOnce()).toBe(1);
    expect(notices).toEqual([aiKeyText('openai', 2)]);
    expect(notices[0]).toContain('OPENAI_API_KEY');
    expect(await dog.runOnce()).toBe(0);

    clock += MINUTE;
    await db.aiCalls.record({ ...call, occurredAt: stamp(clock), outcome: 'ok' });
    expect(await dog.runOnce()).toBe(1);
    expect(notices[1]).toBe(aiKeyFixedText('openai'));
    // The old rejections in the window are followed by a success: no new notice.
    expect(await dog.runOnce()).toBe(0);
  });

  it('keeps watching while the kill switch is on', async () => {
    const control = (await db.repositories.systemControls.getById(
      AUTOMATION_CONTROL_ID,
    )) as SystemControl;
    // The kill switch was created at the database's own time, not at the test epoch.
    const paused = pauseSystem(control, 'Проверка сторожа', {
      actor: OWNER,
      at: stamp(Date.now()),
    });
    await db.repositories.systemControls.update(paused, OWNER);
    try {
      await mark('worker', 15);
      expect(await watchdog().runOnce()).toBe(1);
    } finally {
      await db.repositories.systemControls.update(
        resumeSystem(paused, { actor: OWNER, at: stamp(Date.now()) }),
        OWNER,
      );
    }
  });

  it('runs on its interval and stops cleanly', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await mark('worker', 12);
      const dog = createServiceWatchdog({
        database: db,
        logger,
        deliver,
        version: BOT_VERSION,
        startedAtMs: clock,
        now,
        intervalMs: 1_000,
      });
      dog.start();
      await dog.stop();
      expect(notices).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the daily digest (13c)', () => {
  it('lists the watchdog notices of the day and whether they are over', async () => {
    await mark('worker', 12);
    await mark('api', 1, { version: 'old0000' });
    await watchdog().runOnce();
    const digest = await buildDigest(db, clock);
    expect(digest).toContain(
      '🛠 Сторож за сутки: 2 (worker молчал — не решено; api на другой версии — не решено) → /status',
    );
  });
});

describe('the setup checklist of /status (D-023)', () => {
  it('lists what is left with where to fix it, then reports once that all is set up', async () => {
    const empty = await setupStatus(db, { publicApiUrl: false }, clock);
    expect(empty.complete).toBe(false);
    expect(empty.lines[0]).toBe('🧭 Запуск — осталось 5:');

    await mark('worker', 1, { setup: { ai: ['anthropic', 'google'] } });
    await mark('api', 1, { setup: { panel: true, form: true, payments: false } });
    const pending = await requestAccess(
      db,
      {
        actor: { type: 'integration', id: 'setup-check' },
        displayName: 'Setup check',
        purpose: 'Checks the checklist',
      },
      { at: stamp(clock) },
    );
    const waiting = await setupStatus(db, { publicApiUrl: true }, clock);
    expect(waiting.lines).toEqual([
      '🧭 Запуск — осталось 1:',
      `✅ worker работает · ${BOT_VERSION}`,
      '✅ AI: Anthropic (Claude), Google (Gemini)',
      `✅ api работает · ${BOT_VERSION}`,
      '✅ форма заявки на страницах тестов',
      '✅ кнопка «Пульт»',
      '⚠️ доступов ждут: 1 — /decisions',
    ]);

    const dog = createServiceWatchdog({
      database: db,
      logger,
      deliver,
      version: BOT_VERSION,
      startedAtMs: clock,
      now,
      setup: { publicApiUrl: true },
    });
    expect(await dog.runOnce()).toBe(0);

    // The owner decides the request (as the /decisions button does).
    await db.repositories.approvalRequests.update(
      resolveApprovalRequest(
        pending.request,
        { decision: 'reject' },
        { actor: OWNER, at: stamp(clock) },
      ),
      OWNER,
    );
    const center = createCommandCenter({
      database: db,
      logger,
      deliverDigest: deliver,
      publicApiUrl: 'https://api.example.test',
      now,
    });
    const done = await setupStatus(db, { publicApiUrl: true }, clock);
    expect(done).toEqual({
      complete: true,
      lines: [`🧭 Запуск: всё настроено ✅ (worker ${BOT_VERSION}, api ${BOT_VERSION})`],
    });
    expect(await center.statusLines()).toContain(done.lines[0]);

    expect(await dog.runOnce()).toBe(1);
    expect(notices).toEqual([SETUP_COMPLETE_TEXT]);
    expect(await dog.runOnce()).toBe(0);
  });

  it('shows that the free Gemini key goes first (D-025)', async () => {
    await mark('worker', 1, { setup: { ai: ['google'], ai_free: ['google'] } });
    const { lines } = await setupStatus(db, { publicApiUrl: false }, clock);
    expect(lines).toContain('✅ AI: Google (Gemini) · бесплатный ключ Gemini — первым');
  });

  it('shows a silent service in the checklist', async () => {
    await mark('worker', 30, { setup: { ai: ['openai'] } });
    const { lines } = await setupStatus(db, { publicApiUrl: false }, clock);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^🔴 worker молчит с \d\d\.\d\d \d\d:\d\d — Railway → worker → Deploy Logs$/,
      ),
    );
  });
});
