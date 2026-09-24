import { describe, expect, it } from 'vitest';
import {
  createLogger,
  isLogLevel,
  isSensitiveKey,
  serializeLogRecord,
  type LogRecord,
} from '@roi-dealer/observability';

const FIXED_TIME = new Date('2026-01-02T03:04:05.678Z');

function capture(level: 'debug' | 'info' | 'warn' = 'debug') {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'api',
    level,
    clock: () => FIXED_TIME,
    sink: (line) => lines.push(line),
  });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe('createLogger', () => {
  it('emits one JSON line with the required structured fields', () => {
    const { logger, lines, records } = capture();

    logger.info('request completed', { status: 200 });

    expect(lines).toHaveLength(1);
    expect(records()[0]).toEqual({
      timestamp: '2026-01-02T03:04:05.678Z',
      level: 'info',
      service: 'api',
      message: 'request completed',
      status: 200,
    });
  });

  it('supports an optional correlation_id through child bindings', () => {
    const { logger, records } = capture();

    logger.child({ correlation_id: 'req-123' }).warn('slow request');

    expect(records()[0]).toMatchObject({ level: 'warn', correlation_id: 'req-123' });
  });

  it('filters records below the configured level', () => {
    const { logger, records } = capture('warn');

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');
    logger.error('shown');
    logger.fatal('shown');

    expect(records().map((record) => record.level)).toEqual(['warn', 'error', 'fatal']);
    expect(logger.isLevelEnabled('info')).toBe(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
  });

  it('does not let fields override reserved keys', () => {
    const { logger, records } = capture();

    logger.info('real message', { level: 'fatal', service: 'spoofed', message: 'spoofed' });

    expect(records()[0]).toMatchObject({ level: 'info', service: 'api', message: 'real message' });
  });

  it('drops undefined fields', () => {
    const { logger, records } = capture();
    logger.info('msg', { present: 1, absent: undefined });
    expect(records()[0]).not.toHaveProperty('absent');
  });

  it('never throws when the sink fails', () => {
    const logger = createLogger({
      service: 'api',
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => logger.error('still fine')).not.toThrow();
  });

  it('defaults to info level', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'api', sink: (line) => lines.push(line) });

    logger.debug('suppressed');
    logger.info('emitted');

    expect(logger.level).toBe('info');
    expect(lines).toHaveLength(1);
  });
});

describe('serializeLogRecord', () => {
  const base: LogRecord = {
    timestamp: FIXED_TIME.toISOString(),
    level: 'info',
    service: 'api',
    message: 'm',
  };

  it('redacts sensitive keys at any depth', () => {
    const line = serializeLogRecord({
      ...base,
      password: 'hunter2',
      request: { headers: { Authorization: 'Bearer abc', 'x-api-key': 'k' } },
      config: { DATABASE_URL: 'postgresql://u:p@h/db', apiKey: 'k2' },
    });

    expect(line).not.toMatch(/hunter2|Bearer abc|u:p@h|"k2?"/);
    expect(JSON.parse(line)).toMatchObject({
      password: '[REDACTED]',
      request: { headers: { Authorization: '[REDACTED]', 'x-api-key': '[REDACTED]' } },
      config: { DATABASE_URL: '[REDACTED]', apiKey: '[REDACTED]' },
    });
  });

  it('does not redact look-alike keys such as token counts', () => {
    const parsed = JSON.parse(
      serializeLogRecord({ ...base, token_count: 42, tokens: 7 }),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({ token_count: 42, tokens: 7 });
  });

  it('serializes errors with their cause', () => {
    const error = new Error('outer', { cause: new Error('inner') });
    const parsed = JSON.parse(serializeLogRecord({ ...base, error })) as {
      error: { name: string; message: string; stack: string; cause: { message: string } };
    };
    expect(parsed.error).toMatchObject({
      name: 'Error',
      message: 'outer',
      cause: { message: 'inner' },
    });
    expect(parsed.error.stack).toContain('outer');
  });

  it('handles bigint and circular references without throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    const parsed = JSON.parse(serializeLogRecord({ ...base, amount: 10n, circular })) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({ amount: '10', circular: { name: 'loop', self: '[Circular]' } });
  });
});

describe('log helpers', () => {
  it('recognises log levels', () => {
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel(1)).toBe(false);
  });

  it.each([
    'password',
    'DB_PASSWORD',
    'API_KEY',
    'x-api-key',
    'OPENAI_API_KEY',
    'apiKey',
    'refreshToken',
    'github_token',
    'Set-Cookie',
    'client_secret',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['token_count', 'tokens', 'max_tokens', 'input_tokens', 'status', 'secretary_id'])(
    'does not treat %s as sensitive',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});
