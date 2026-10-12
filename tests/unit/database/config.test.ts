import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig } from '@roi-dealer/database';
import { ConfigValidationError } from '@roi-dealer/shared';

const URL_WITH_PASSWORD = 'postgresql://roi:s3cret-pass@db.internal:5432/roi';

describe('loadDatabaseConfig', () => {
  it('accepts a postgres URL and applies pool defaults', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: URL_WITH_PASSWORD })).toEqual({
      DATABASE_URL: URL_WITH_PASSWORD,
      DATABASE_POOL_MAX: 5,
      DATABASE_CONNECT_TIMEOUT_SECONDS: 10,
    });
  });

  it('accepts the postgres:// scheme and explicit pool settings', () => {
    expect(
      loadDatabaseConfig({
        DATABASE_URL: 'postgres://roi@localhost/roi',
        DATABASE_POOL_MAX: '10',
        DATABASE_CONNECT_TIMEOUT_SECONDS: '3',
      }),
    ).toMatchObject({ DATABASE_POOL_MAX: 10, DATABASE_CONNECT_TIMEOUT_SECONDS: 3 });
  });

  it.each([
    ['missing', {}],
    ['another database scheme', { DATABASE_URL: 'mysql://roi:s3cret-pass@db/roi' }],
    ['not a URL', { DATABASE_URL: 's3cret-pass' }],
  ])('rejects a %s DATABASE_URL without revealing it', (_case, env) => {
    let error: unknown;
    try {
      loadDatabaseConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as Error).message).toContain('DATABASE_URL');
    expect((error as Error).message).not.toContain('s3cret-pass');
  });

  it('bounds the pool size', () => {
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: URL_WITH_PASSWORD, DATABASE_POOL_MAX: '0' }),
    ).toThrow(/DATABASE_POOL_MAX/);
  });
});
