import { describe, expect, it } from 'vitest';
import { isValidCorrelationId, resolveCorrelationId } from '@roi-dealer/observability';

const generate = () => 'generated-id';

describe('resolveCorrelationId', () => {
  it('keeps a well-formed incoming id', () => {
    expect(resolveCorrelationId('req-123:abc.DEF_4', generate)).toBe('req-123:abc.DEF_4');
  });

  it('uses the first value of a repeated header', () => {
    expect(resolveCorrelationId(['first', 'second'], generate)).toBe('first');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['log injection', 'abc\n{"level":"fatal"}'],
    ['too long', 'a'.repeat(129)],
    ['spaces', 'has space'],
  ])('replaces a %s id with a generated one', (_case, incoming) => {
    expect(resolveCorrelationId(incoming, generate)).toBe('generated-id');
  });

  it('generates UUIDs by default', () => {
    expect(resolveCorrelationId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('validates ids', () => {
    expect(isValidCorrelationId('a'.repeat(128))).toBe(true);
    expect(isValidCorrelationId('a'.repeat(129))).toBe(false);
  });
});
