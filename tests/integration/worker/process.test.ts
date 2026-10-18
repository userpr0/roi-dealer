import { describe, expect, it } from 'vitest';
import { approvePrincipal, toTimestamp } from '@roi-dealer/domain';
import { createTestDatabase } from '../../support/database.js';
import { OWNER } from '../../support/domain.js';
import { startFakeHackerNews } from '../../support/fake-hacker-news.js';
import { startService } from '../../support/service-process.js';

describe('worker process', () => {
  it('starts, emits heartbeats and stops gracefully on SIGTERM', async () => {
    const service = startService('apps/worker/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      WORKER_HEARTBEAT_INTERVAL_MS: '100',
    });

    try {
      await service.waitForLog((line) => line['message'] === 'worker started');
      await service.waitForLog((line) => line['message'] === 'worker heartbeat');

      service.child.kill('SIGTERM');

      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      const messages = service.logs.map((line) => line['message']);
      expect(messages).toEqual(expect.arrayContaining(['worker stopped', 'shutdown completed']));
      expect(service.logs.every((line) => line['service'] === 'worker')).toBe(true);
    } finally {
      service.kill();
    }
  });

  it('stops gracefully on SIGINT', async () => {
    const service = startService('apps/worker/src/main.ts', { NODE_ENV: 'test' });

    try {
      await service.waitForLog((line) => line['message'] === 'worker started');
      service.child.kill('SIGINT');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    } finally {
      service.kill();
    }
  });

  it('exits with code 1 on invalid configuration', async () => {
    const service = startService('apps/worker/src/main.ts', {
      WORKER_HEARTBEAT_INTERVAL_MS: 'soon',
    });

    await expect(service.waitForExit()).resolves.toMatchObject({ code: 1 });
    expect(JSON.stringify(service.logs)).toContain('WORKER_HEARTBEAT_INTERVAL_MS');
  });
});

describe('worker process with a database (PHASE 05)', () => {
  it('asks the owner for access, collects evidence after the grant and stops cleanly', async () => {
    const test = await createTestDatabase();
    const hn = await startFakeHackerNews();
    hn.publish([
      {
        id: 7,
        type: 'story',
        by: 'author_x',
        time: Math.floor(Date.now() / 1_000) - 60,
        title: 'Ask HN: How do you track client hours?',
        text: 'Call me at 555-123-4567 if you solved it',
      },
    ]);
    const service = startService('apps/worker/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: test.url,
      EVIDENCE_COLLECT_INTERVAL_MS: '200',
      HACKER_NEWS_API_URL: hn.baseUrl,
    });

    try {
      await service.waitForLog((line) => line['message'] === 'evidence collection scheduled');
      await service.waitForLog(
        (line) =>
          line['message'] === 'evidence collection skipped' &&
          line['reason'] === 'access_not_active',
      );
      expect(hn.requests).toEqual([]);

      // The owner grants the integration in /decisions.
      const principal = await test.database.repositories.principals.getByActor({
        type: 'integration',
        id: 'source:hacker-news',
      });
      if (principal === undefined) throw new Error('the worker did not ask for access');
      await test.database.repositories.principals.update(
        approvePrincipal(principal, { actor: OWNER, at: toTimestamp(new Date()) }),
        OWNER,
      );

      await service.waitForLog((line) => line['message'] === 'evidence collected');
      const rows = await test.database.sql<{ excerpt: string }[]>`select excerpt from evidence`;
      expect(rows.map((row) => row.excerpt)).toEqual([
        'Ask HN: How do you track client hours?\n\nCall me at [phone] if you solved it',
      ]);

      service.child.kill('SIGTERM');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      const output = JSON.stringify(service.logs) + service.stderr();
      for (const secret of [test.url, '555-123-4567', 'author_x']) {
        expect(output).not.toContain(secret);
      }
    } finally {
      service.kill();
      await hn.close();
      await test.drop();
    }
  });
});
