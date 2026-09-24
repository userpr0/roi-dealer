import { describe, expect, it } from 'vitest';
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
