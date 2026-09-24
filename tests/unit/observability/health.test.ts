import { describe, expect, it, vi } from 'vitest';
import {
  createHealthRegistry,
  type HealthCheck,
  type HealthStatus,
} from '@roi-dealer/observability';

function check(name: string, status: HealthStatus, critical?: boolean): HealthCheck {
  return {
    name,
    ...(critical === undefined ? {} : { critical }),
    check: () => Promise.resolve({ status }),
  };
}

describe('createHealthRegistry', () => {
  it('reports ok without a checks section when nothing is registered', async () => {
    const registry = createHealthRegistry({ service: 'api' });
    await expect(registry.run()).resolves.toEqual({ status: 'ok', service: 'api' });
  });

  it('reports ok when every check is ok', async () => {
    const registry = createHealthRegistry({ service: 'api' });
    registry.register(check('database', 'ok'));

    const report = await registry.run();

    expect(report.status).toBe('ok');
    expect(report.checks?.['database']).toMatchObject({ status: 'ok' });
    expect(report.checks?.['database']?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('is down when a critical check is down', async () => {
    const registry = createHealthRegistry({ service: 'api' });
    registry.register(check('database', 'down'));
    registry.register(check('storage', 'ok'));
    await expect(registry.run()).resolves.toMatchObject({ status: 'down' });
  });

  it('is degraded when a non-critical check is down', async () => {
    const registry = createHealthRegistry({ service: 'api' });
    registry.register(check('ai-provider', 'down', false));
    await expect(registry.run()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('is degraded when a check is degraded', async () => {
    const registry = createHealthRegistry({ service: 'api' });
    registry.register(check('temporal', 'degraded'));
    await expect(registry.run()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('marks a throwing check as down without exposing the raw error', async () => {
    const onCheckError = vi.fn();
    const registry = createHealthRegistry({ service: 'api', onCheckError });
    const error = new Error('password authentication failed for user "roi"');
    registry.register({ name: 'database', check: () => Promise.reject(error) });

    const report = await registry.run();

    expect(report.status).toBe('down');
    expect(report.checks?.['database']).toMatchObject({ details: { error: 'check_failed' } });
    expect(JSON.stringify(report)).not.toContain('password');
    expect(onCheckError).toHaveBeenCalledWith('database', error);
  });

  it('marks a hanging check as timed out', async () => {
    const registry = createHealthRegistry({ service: 'api', defaultTimeoutMs: 20 });
    registry.register({ name: 'temporal', check: () => new Promise(() => undefined) });

    const report = await registry.run();

    expect(report.checks?.['temporal']).toMatchObject({
      status: 'down',
      details: { error: 'timeout' },
    });
  });

  it('rejects duplicate check names', () => {
    const registry = createHealthRegistry({ service: 'api' });
    registry.register(check('database', 'ok'));
    expect(() => registry.register(check('database', 'ok'))).toThrow(/already registered/);
  });
});
