import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@roi-dealer/shared';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 identifiers', () => {
    expect(uuidv7()).toMatch(UUID_V7);
  });

  it('encodes the Unix time in milliseconds in the first 48 bits', () => {
    const now = Date.parse('2026-09-24T10:00:00.123Z');
    const id = uuidv7(now);
    const encoded = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(encoded).toBe(now);
  });

  it('sorts by creation time', () => {
    const ids = [3, 1, 2].map((offset) => uuidv7(1_700_000_000_000 + offset * 1_000));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => uuidv7(1_700_000_000_000)));
    expect(ids.size).toBe(1_000);
  });
});
