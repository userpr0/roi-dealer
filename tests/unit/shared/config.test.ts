import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigValidationError, loadConfig, nodeEnvSchema, portSchema } from '@roi-dealer/shared';

const schema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  PORT: portSchema.default(3000),
  API_TOKEN: z.string().min(40),
});

describe('loadConfig', () => {
  it('applies defaults and coerces values', () => {
    const config = loadConfig(schema, { PORT: '8080', API_TOKEN: 'x'.repeat(40) });
    expect(config).toEqual({ NODE_ENV: 'development', PORT: 8080, API_TOKEN: 'x'.repeat(40) });
  });

  it('treats empty strings as unset so defaults apply', () => {
    const config = loadConfig(schema, { NODE_ENV: '', PORT: '  ', API_TOKEN: 'x'.repeat(40) });
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
  });

  it('ignores unrelated environment variables', () => {
    const config = loadConfig(schema, { API_TOKEN: 'x'.repeat(40), UNRELATED: 'value' });
    expect(config).not.toHaveProperty('UNRELATED');
  });

  it('reports every invalid key', () => {
    let caught: unknown;
    try {
      loadConfig(schema, { NODE_ENV: 'staging', PORT: '70000' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const keys = (caught as ConfigValidationError).issues.map((issue) => issue.key);
    expect(keys).toEqual(expect.arrayContaining(['NODE_ENV', 'PORT', 'API_TOKEN']));
  });

  it('never includes raw values in the error', () => {
    const secretLikeValue = 'sk-live-should-never-appear';
    expect(() => loadConfig(schema, { API_TOKEN: secretLikeValue })).toThrow(ConfigValidationError);
    try {
      loadConfig(schema, { API_TOKEN: secretLikeValue });
    } catch (error) {
      expect(String(error)).not.toContain(secretLikeValue);
      expect(JSON.stringify(error)).not.toContain(secretLikeValue);
    }
  });
});

describe('portSchema', () => {
  it.each(['0', '1', '65535'])('accepts %s', (value) => {
    expect(portSchema.safeParse(value).success).toBe(true);
  });

  it.each(['-1', '65536', '3000.5', 'abc'])('rejects %s', (value) => {
    expect(portSchema.safeParse(value).success).toBe(false);
  });
});
