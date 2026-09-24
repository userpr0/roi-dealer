import { describe, expect, it } from 'vitest';
import {
  addMoney,
  APPROVAL_STATUSES,
  approvalLifecycle,
  CONTRIBUTION_STATUSES,
  compareMoney,
  contributionLifecycle,
  countryCodeSchema,
  defineStateMachine,
  DomainError,
  EXPERIMENT_STATUSES,
  experimentLifecycle,
  formatUsd,
  HYPOTHESIS_STATUSES,
  hypothesisLifecycle,
  languageTagSchema,
  moneySchema,
  OPPORTUNITY_STATUSES,
  opportunityLifecycle,
  PAIN_STATUSES,
  painLifecycle,
  REWARD_STATUSES,
  rewardLifecycle,
  SIGNAL_STATUSES,
  signalLifecycle,
  SOURCE_STATUSES,
  sourceLifecycle,
  subtractMoney,
  sumMoney,
  timestampSchema,
  toTimestamp,
  uniqueList,
  usd,
  ZERO_USD,
  type StateMachine,
} from '@roi-dealer/domain';
import { z } from 'zod';

describe('Money', () => {
  it('works in integer cents without floating point drift', () => {
    const total = sumMoney([usd(10), usd(20), usd(3_000)]);
    expect(total).toEqual({ currency: 'USD', amountCents: 3_030 });
    expect(addMoney(usd(1), usd(2))).toEqual(usd(3));
    expect(subtractMoney(usd(1), usd(2))).toEqual(usd(-1));
    expect(sumMoney([])).toEqual(ZERO_USD);
  });

  it('compares amounts', () => {
    expect(compareMoney(usd(1), usd(2))).toBe(-1);
    expect(compareMoney(usd(2), usd(2))).toBe(0);
    expect(compareMoney(usd(3), usd(2))).toBe(1);
  });

  it('rejects fractional or unsafe cents', () => {
    expect(() => usd(1.5)).toThrow(DomainError);
    expect(() => usd(2 ** 60)).toThrow(DomainError);
    expect(moneySchema.safeParse({ currency: 'USD', amountCents: 1.5 }).success).toBe(false);
    expect(moneySchema.safeParse({ currency: 'EUR', amountCents: 100 }).success).toBe(false);
  });

  it('formats for display', () => {
    expect(formatUsd(usd(123_450))).toBe('$1,234.50');
    expect(formatUsd(usd(-2_000))).toBe('-$20.00');
  });
});

describe('primitives', () => {
  it('accepts only UTC timestamps', () => {
    expect(timestampSchema.safeParse('2026-10-01T10:00:00Z').success).toBe(true);
    expect(timestampSchema.safeParse('2026-10-01T10:00:00.123Z').success).toBe(true);
    expect(timestampSchema.safeParse('2026-10-01T13:00:00+03:00').success).toBe(false);
    expect(timestampSchema.safeParse('2026-10-01').success).toBe(false);
    expect(toTimestamp(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  });

  it('validates country codes and language tags', () => {
    expect(countryCodeSchema.safeParse('US').success).toBe(true);
    expect(countryCodeSchema.safeParse('usa').success).toBe(false);
    expect(languageTagSchema.safeParse('en-US').success).toBe(true);
    expect(languageTagSchema.safeParse('English').success).toBe(false);
  });

  it('rejects duplicates in unique lists', () => {
    const list = uniqueList(z.string(), { min: 1, max: 3 });
    expect(list.safeParse(['a', 'b']).success).toBe(true);
    expect(list.safeParse(['a', 'a']).success).toBe(false);
    expect(list.safeParse([]).success).toBe(false);
  });
});

describe('state machines', () => {
  const machine = defineStateMachine<'a' | 'b' | 'c'>('source', { a: ['b'], b: ['c'], c: [] });

  it('allows only declared transitions', () => {
    expect(machine.canTransition('a', 'b')).toBe(true);
    expect(machine.canTransition('a', 'c')).toBe(false);
    expect(machine.isTerminal('c')).toBe(true);
    expect(() => machine.assertTransition('a', 'c')).toThrow(
      expect.objectContaining({
        code: 'invalid_transition',
        details: expect.objectContaining({ allowed: ['b'] }) as unknown,
      }),
    );
  });

  it.each([
    ['source', SOURCE_STATUSES, sourceLifecycle],
    ['signal', SIGNAL_STATUSES, signalLifecycle],
    ['pain', PAIN_STATUSES, painLifecycle],
    ['opportunity', OPPORTUNITY_STATUSES, opportunityLifecycle],
    ['approval', APPROVAL_STATUSES, approvalLifecycle],
    ['hypothesis', HYPOTHESIS_STATUSES, hypothesisLifecycle],
    ['experiment', EXPERIMENT_STATUSES, experimentLifecycle],
    ['contribution', CONTRIBUTION_STATUSES, contributionLifecycle],
    ['reward', REWARD_STATUSES, rewardLifecycle],
  ] as [string, readonly string[], StateMachine<string>][])(
    '%s lifecycle covers exactly the schema statuses',
    (_name, statuses, lifecycle) => {
      expect([...lifecycle.states].sort()).toEqual([...statuses].sort());
      for (const state of lifecycle.states) {
        for (const next of lifecycle.nextStates(state)) expect(statuses).toContain(next);
      }
    },
  );
});
