import { afterEach, describe, expect, it } from 'vitest';
import { createHealthRegistry } from '@roi-dealer/observability';
import { createRouter, type Router } from '../../../apps/api/src/router.js';
import { startApiServer, type ApiServer } from '../../../apps/api/src/server.js';
import { createCapturingLogger } from '../../support/logger.js';

let server: ApiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(router?: Router) {
  const { logger, records } = createCapturingLogger('api');
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: router ?? createRouter({ health: createHealthRegistry({ service: 'api' }) }),
    logger,
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, records };
}

describe('api http server', () => {
  it('serves GET /health as JSON', async () => {
    const { baseUrl } = await start();

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'api' });
  });

  it('ignores the query string when routing', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/health?verbose=1`);
    expect(response.status).toBe(200);
  });

  it('answers HEAD without a body', async () => {
    const { baseUrl } = await start();

    const response = await fetch(`${baseUrl}/health`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
  });

  it('propagates a valid correlation id and logs it', async () => {
    const { baseUrl, records } = await start();

    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'x-correlation-id': 'owner-check-42' },
    });

    expect(response.headers.get('x-correlation-id')).toBe('owner-check-42');
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'request completed',
        correlation_id: 'owner-check-42',
        method: 'GET',
        path: '/health',
        status: 200,
      }),
    );
  });

  it('generates a correlation id when none is provided', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 405 with an Allow header for unsupported methods', async () => {
    const { baseUrl } = await start();

    const response = await fetch(`${baseUrl}/health`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('returns 404 for unknown routes', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/unknown`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('hides handler failures behind a generic 500 and logs them', async () => {
    const { baseUrl, records } = await start(() => Promise.reject(new Error('db password=secret')));

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'internal_error' });
    expect(body).not.toContain('secret');
    expect(records).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'request handler failed' }),
    );
  });
});
