import { describe, expect, it } from 'vitest';
import {
  formatKyivDate,
  formatKyivDateTime,
  kyivDate,
  kyivInstant,
  kyivTimeToday,
  nextKyivTime,
} from '@roi-dealer/command-center';

const ms = (iso: string): number => Date.parse(iso);
const iso = (value: number): string => new Date(value).toISOString();

describe('Kyiv time (D-009)', () => {
  it('is UTC+3 in summer and UTC+2 in winter', () => {
    expect(iso(kyivInstant(2026, 9, 25, 10))).toBe('2026-09-25T07:00:00.000Z');
    expect(iso(kyivInstant(2026, 12, 1, 10))).toBe('2026-12-01T08:00:00.000Z');
  });

  it.each([
    // Spring forward: Sunday 29 March 2026, 03:00 → 04:00 local.
    ['2026-03-28T05:00:00.000Z', '2026-03-28T08:00:00.000Z'],
    ['2026-03-28T12:00:00.000Z', '2026-03-29T07:00:00.000Z'],
    // Fall back: Sunday 25 October 2026, 04:00 → 03:00 local.
    ['2026-10-24T12:00:00.000Z', '2026-10-25T08:00:00.000Z'],
    ['2026-10-25T02:00:00.000Z', '2026-10-25T08:00:00.000Z'],
    // Exactly at 10:00 the next digest is tomorrow.
    ['2026-09-25T07:00:00.000Z', '2026-09-26T07:00:00.000Z'],
    // Across the year.
    ['2026-12-31T09:00:00.000Z', '2027-01-01T08:00:00.000Z'],
  ])('after %s the next 10:00 Kyiv is %s', (now, expected) => {
    expect(iso(nextKyivTime(ms(now), 10))).toBe(expected);
  });

  it('gives today’s time even when it has passed', () => {
    expect(iso(kyivTimeToday(ms('2026-09-25T20:00:00.000Z'), 10))).toBe('2026-09-25T07:00:00.000Z');
  });

  it('uses the Kyiv calendar day near midnight', () => {
    expect(kyivDate(ms('2026-09-24T21:30:00.000Z'))).toBe('2026-09-25');
    expect(kyivDate(ms('2026-09-24T20:30:00.000Z'))).toBe('2026-09-24');
    expect(formatKyivDate(ms('2026-12-31T22:30:00.000Z'))).toBe('01.01.2027');
  });

  it('formats owner-facing times', () => {
    expect(formatKyivDateTime(ms('2026-09-25T11:05:00.000Z'))).toBe('25.09 14:05');
    expect(formatKyivDateTime(ms('2026-09-24T21:00:00.000Z'))).toBe('25.09 00:00');
  });
});
