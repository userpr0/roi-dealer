import { describe, expect, it } from 'vitest';
import { addDays, interestTrend, PULSE_WINDOW_DAYS } from '@roi-dealer/domain';

const TODAY = '2026-11-03';

/** A series of `days` daily points ending on `end`: the first `baselineDays` at `base`, then `recent`. */
function series(
  end: string,
  baselineDays: number,
  base: number,
  recentDays: number,
  recent: number,
) {
  const points: { day: string; value: number }[] = [];
  const total = baselineDays + recentDays;
  for (let i = 0; i < total; i += 1) {
    points.push({ day: addDays(end, i - total + 1), value: i < baselineDays ? base : recent });
  }
  return points;
}

describe('interestTrend (05c, §2.13)', () => {
  it('reports rising, falling and flat interest from the recent week against four weeks before', () => {
    expect(interestTrend(series(TODAY, 28, 100, 7, 200), TODAY)).toEqual({
      direction: 'rising',
      recentAverage: 200,
      baselineAverage: 100,
      ratio: 2,
    });
    expect(interestTrend(series(TODAY, 28, 100, 7, 50), TODAY)).toMatchObject({
      direction: 'falling',
      ratio: 0.5,
    });
    expect(interestTrend(series(TODAY, 28, 100, 7, 110), TODAY)).toMatchObject({
      direction: 'flat',
      ratio: 1.1,
    });
  });

  it('needs at least half of each window and a baseline above zero', () => {
    expect(interestTrend(series(TODAY, 10, 100, 7, 200), TODAY)).toEqual({
      direction: 'insufficient',
    });
    // A full baseline, but only 3 of the 7 recent days.
    const sparseRecent = [
      ...series(addDays(TODAY, -7), 28, 100, 0, 0),
      ...[0, 1, 2].map((offset) => ({ day: addDays(TODAY, -offset), value: 200 })),
    ];
    expect(interestTrend(sparseRecent, TODAY)).toEqual({ direction: 'insufficient' });
    expect(interestTrend(series(TODAY, 28, 0, 7, 50), TODAY)).toMatchObject({
      direction: 'insufficient',
      baselineAverage: 0,
    });
    expect(interestTrend([], TODAY)).toEqual({ direction: 'insufficient' });
  });

  it('ignores points outside both windows and takes its thresholds from the options', () => {
    const points = [
      ...series(TODAY, 28, 100, 7, 130),
      { day: addDays(TODAY, 1), value: 10_000 },
      { day: addDays(TODAY, -60), value: 10_000 },
    ];
    expect(interestTrend(points, TODAY).direction).toBe('flat');
    expect(interestTrend(points, TODAY, { risingRatio: 1.25 }).direction).toBe('rising');
  });

  it('counts days across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(PULSE_WINDOW_DAYS).toBe(42);
  });
});
