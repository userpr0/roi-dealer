import { describe, expect, it } from 'vitest';
import { createHealthRegistry } from '@roi-dealer/observability';
import { loadApiConfig } from '../../../apps/api/src/config.js';
import { createRouter, PANEL_PATH, type PanelRoute } from '../../../apps/api/src/router.js';

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

describe('the Mini App panel route (PHASE 13, ADR-0008)', () => {
  const ORIGIN = 'https://userpr0.github.io';
  const reads: (string | undefined)[] = [];
  const panel: PanelRoute = {
    origins: [ORIGIN],
    read: (authorization) => {
      reads.push(authorization);
      return Promise.resolve({ status: 200, body: { ok: true } });
    },
  };
  const router = createRouter({ health: createHealthRegistry({ service: 'api' }), panel });

  it('lets only the Mini App’s origin read the response', async () => {
    await expect(
      router({
        method: 'GET',
        path: PANEL_PATH,
        headers: { origin: ORIGIN, authorization: 'tma signed' },
      }),
    ).resolves.toEqual({
      status: 200,
      body: { ok: true },
      headers: { 'access-control-allow-origin': ORIGIN, vary: 'origin' },
    });
    expect(reads.at(-1)).toBe('tma signed');
    // Another site gets no CORS header, so a browser keeps the answer from it.
    const other = await router({
      method: 'GET',
      path: PANEL_PATH,
      headers: { origin: 'https://evil.example', authorization: 'tma signed' },
    });
    expect(other.headers).toEqual({ vary: 'origin' });
  });

  it('answers the preflight only for the Mini App’s origin', async () => {
    await expect(
      router({ method: 'OPTIONS', path: PANEL_PATH, headers: { origin: ORIGIN } }),
    ).resolves.toEqual({
      status: 204,
      body: undefined,
      headers: {
        'access-control-allow-origin': ORIGIN,
        vary: 'origin',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization',
        'access-control-max-age': '600',
      },
    });
    await expect(
      router({ method: 'OPTIONS', path: PANEL_PATH, headers: { origin: 'https://evil.example' } }),
    ).resolves.toMatchObject({ status: 403, body: { error: 'origin_not_allowed' } });
    await expect(router({ method: 'OPTIONS', path: PANEL_PATH })).resolves.toMatchObject({
      status: 403,
    });
  });

  it('is read-only and answers 503 until it is configured', async () => {
    await expect(
      router({ method: 'POST', path: PANEL_PATH, headers: { origin: ORIGIN } }),
    ).resolves.toMatchObject({ status: 405, headers: { allow: 'GET, OPTIONS' } });
    const bare = createRouter({ health: createHealthRegistry({ service: 'api' }) });
    await expect(bare({ method: 'GET', path: PANEL_PATH })).resolves.toEqual({
      status: 503,
      body: { error: 'not_configured' },
      headers: { vary: 'origin' },
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
      MINIAPP_ORIGINS: ['https://userpr0.github.io'],
    });
  });

  it('reads the Mini App’s origins and refuses an origin with a path or without https', () => {
    expect(
      loadApiConfig({ MINIAPP_ORIGINS: 'https://userpr0.github.io, https://example.com' }),
    ).toMatchObject({ MINIAPP_ORIGINS: ['https://userpr0.github.io', 'https://example.com'] });
    expect(() =>
      loadApiConfig({ MINIAPP_ORIGINS: 'https://userpr0.github.io/roi-dealer' }),
    ).toThrow(/MINIAPP_ORIGINS/);
    expect(() => loadApiConfig({ MINIAPP_ORIGINS: 'http://example.com' })).toThrow(
      /MINIAPP_ORIGINS/,
    );
    expect(() => loadApiConfig({ TELEGRAM_OWNER_USER_ID: 'owner' })).toThrow(
      /TELEGRAM_OWNER_USER_ID/,
    );
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
