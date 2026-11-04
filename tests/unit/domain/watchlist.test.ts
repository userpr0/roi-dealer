import { describe, expect, it } from 'vitest';
import { watchGrowth } from '@roi-dealer/domain';

describe('the watchlist growth rule (phase 27)', () => {
  const snapshot = { signals: 2, sources: ['forum'] };

  it('asks the owner at twice the cut signals from a source the cut pain never had', () => {
    expect(
      watchGrowth(snapshot, [
        { signals: 3, sources: ['forum', 'news'] },
        { signals: 1, sources: ['news'] },
      ]),
    ).toEqual({ signals: 4, newSources: ['news'], growing: true });
  });

  it('does not ask on the same sources or on too few signals', () => {
    expect(watchGrowth(snapshot, [{ signals: 6, sources: ['forum'] }]).growing).toBe(false);
    expect(watchGrowth(snapshot, [{ signals: 3, sources: ['news'] }]).growing).toBe(false);
    expect(
      watchGrowth({ signals: 0, sources: [] }, [{ signals: 1, sources: ['news'] }]).growing,
    ).toBe(false);
  });

  it('after the owner kept it cut, asks again only when the signals double', () => {
    const echoes = [{ signals: 5, sources: ['news'] }];
    expect(watchGrowth(snapshot, echoes, 4).growing).toBe(false);
    expect(watchGrowth(snapshot, [{ signals: 8, sources: ['news'] }], 4).growing).toBe(true);
  });
});

describe('/seek words', () => {
  it('keeps 2–5 plain English words', async () => {
    const { seekQuery } = await import('@roi-dealer/command-center');
    expect(seekQuery('Escrow for Freelancers!')).toBe('escrow for freelancers');
    expect(seekQuery('гарант сделок')).toBeUndefined();
    expect(seekQuery('escrow')).toBeUndefined();
    expect(seekQuery('one two three four five six')).toBeUndefined();
  });
});
