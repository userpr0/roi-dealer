import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { startService, type ServiceProcess } from '../../support/service-process.js';

describe('api process', () => {
  let service: ServiceProcess;
  let baseUrl: string;

  beforeAll(async () => {
    service = startService('apps/api/src/main.ts', {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: '0',
    });
    const listening = await service.waitForLog((line) => line['message'] === 'api listening');
    baseUrl = `http://127.0.0.1:${String(listening['port'])}`;
  });

  afterAll(() => {
    service.kill();
  });

  it('starts and answers GET /health', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'api' });
  });

  it('shuts down gracefully on SIGTERM with exit code 0', async () => {
    service.child.kill('SIGTERM');

    await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    const messages = service.logs.map((line) => line['message']);
    expect(messages).toEqual(
      expect.arrayContaining([
        'shutdown signal received',
        'shutdown hook completed',
        'shutdown completed',
      ]),
    );
  });

  it('writes only structured JSON logs to stdout', () => {
    expect(service.logs.length).toBeGreaterThan(0);
    for (const line of service.logs) {
      expect(line).toMatchObject({
        timestamp: expect.any(String) as unknown,
        level: expect.any(String) as unknown,
        service: 'api',
        message: expect.any(String) as unknown,
      });
    }
    expect(service.stderr()).toBe('');
  });
});

describe('api process with invalid configuration', () => {
  it('exits with code 1 and names the invalid key', async () => {
    const service = startService('apps/api/src/main.ts', { API_PORT: 'not-a-port' });

    await expect(service.waitForExit()).resolves.toMatchObject({ code: 1 });
    const fatal = service.logs.find((line) => line['level'] === 'fatal');
    expect(fatal?.['message']).toBe('api failed to start');
    expect(JSON.stringify(fatal)).toContain('API_PORT');
    expect(JSON.stringify(fatal)).not.toContain('not-a-port');
  });
});

describe('api process with a database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  async function healthOf(databaseUrl: string): Promise<{ status: number; body: unknown }> {
    const service = startService('apps/api/src/main.ts', {
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: '0',
      DATABASE_URL: databaseUrl,
      DATABASE_CONNECT_TIMEOUT_SECONDS: '1',
    });
    try {
      const listening = await service.waitForLog((line) => line['message'] === 'api listening');
      const response = await fetch(`http://127.0.0.1:${String(listening['port'])}/health`);
      const body: unknown = await response.json();
      service.child.kill('SIGTERM');
      await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
      expect(JSON.stringify(service.logs)).not.toContain('roi_dealer_dev_only');
      return { status: response.status, body };
    } finally {
      service.kill();
    }
  }

  it('reports the database check in GET /health', async () => {
    await expect(healthOf(database.url)).resolves.toMatchObject({
      status: 200,
      body: { status: 'ok', service: 'api', checks: { database: { status: 'ok' } } },
    });
  });

  it('answers 503 when the database is unreachable', async () => {
    const unreachable = 'postgresql://roi_dealer:roi_dealer_dev_only@127.0.0.1:1/roi_dealer_dev';
    await expect(healthOf(unreachable)).resolves.toMatchObject({
      status: 503,
      body: { status: 'down', checks: { database: { status: 'down' } } },
    });
  });
});
