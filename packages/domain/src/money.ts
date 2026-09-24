import { z } from 'zod';
import { DomainError } from './errors.js';

/**
 * Amount in integer cents. All accounting is in USD (owner decision D-005);
 * the currency field is kept so another currency can be added without a data migration.
 */
export const moneySchema = z.strictObject({
  currency: z.literal('USD'),
  amountCents: z.int(),
});
export type Money = z.infer<typeof moneySchema>;

export const nonNegativeMoneySchema = moneySchema.refine(
  (money) => money.amountCents >= 0,
  'amount must not be negative',
);
export const positiveMoneySchema = moneySchema.refine(
  (money) => money.amountCents > 0,
  'amount must be positive',
);

export function usd(amountCents: number): Money {
  if (!Number.isSafeInteger(amountCents)) {
    throw new DomainError('invariant_violation', 'Money must be a safe integer number of cents');
  }
  return { currency: 'USD', amountCents };
}

export const ZERO_USD: Money = usd(0);

export function addMoney(a: Money, b: Money): Money {
  return usd(a.amountCents + b.amountCents);
}

export function subtractMoney(a: Money, b: Money): Money {
  return usd(a.amountCents - b.amountCents);
}

export function sumMoney(items: readonly Money[]): Money {
  return items.reduce(addMoney, ZERO_USD);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  return a.amountCents === b.amountCents ? 0 : a.amountCents < b.amountCents ? -1 : 1;
}

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Display only, e.g. `$1,234.50`. Never parse this back into Money. */
export function formatUsd(money: Money): string {
  return usdFormat.format(money.amountCents / 100);
}
