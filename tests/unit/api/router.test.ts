import { describe, expect, it } from 'vitest';
import { createHealthRegistry } from '@roi-dealer/observability';
import { loadApiConfig } from '../../../apps/api/src/config.js';
import { createRouter } from '../../../apps/api/src/router.js';

describe('api router', () => {
  const router = createRouter({ health: createHealthRegistry({ service: 'api' }) });

  it('GET /health returns the PHASE 00 health contract', async () => {
    await expect(router({ method: 'GET', path: '/health' })).resolves.toEqual({
      status: 200,
      body: { status: 'ok', service: 'api' },
    });
  });

  it('HEAD /health is allowed', async () => {
    await expect(router({ method: 'HEAD', path: '/health' })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('rejects other methods on /health with 405', async () => {
    await expect(router({ method: 'POST', path: '/health' })).resolves.toEqual({
      status: 405,
      body: { error: 'method_not_allowed' },
      headers: { allow: 'GET, HEAD' },
    });
  });

  it('returns 503 when a critical dependency is down', async () => {
    const health = createHealthRegistry({ service: 'api' });
    health.register({ name: 'database', check: () => Promise.resolve({ status: 'down' }) });

    const response = await createRouter({ health })({ method: 'GET', path: '/health' });

    expect(response.status).toBe(503);
  });

  it('returns 404 for unknown routes', async () => {
    await expect(router({ method: 'GET', path: '/opportunities' })).resolves.toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });
});

describe('api config', () => {
  it('uses safe local defaults and needs no database', () => {
    expect(loadApiConfig({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      DATABASE_POOL_MAX: 5,
      DATABASE_CONNECT_TIMEOUT_SECONDS: 10,
    });
  });

  it('accepts a database URL and rejects a malformed one', () => {
    expect(loadApiConfig({ DATABASE_URL: 'postgresql://roi@localhost/roi' })).toMatchObject({
      DATABASE_URL: 'postgresql://roi@localhost/roi',
    });
    expect(() => loadApiConfig({ DATABASE_URL: 'localhost:5432' })).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadApiConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});
