import { z } from 'zod';
import { immutableMeta, immutableMetaShape, parseEntity, type CreateContext } from '../entity.js';
import { addMoney, positiveMoneySchema, subtractMoney, ZERO_USD, type Money } from '../money.js';
import {
  experimentIdSchema,
  hypothesisIdSchema,
  opportunityIdSchema,
  revenueEntryIdSchema,
  text,
  timestampSchema,
  type RevenueEntryId,
} from '../primitives.js';

/**
 * `payment`: confirmed revenue. `preorder`: money paid before the product exists — a liability
 * until it is delivered, refunded if it never is (D-014 п.8).
 */
export const REVENUE_KINDS = ['payment', 'preorder'] as const;
export type RevenueKind = (typeof REVENUE_KINDS)[number];

const newRevenueEntryShape = {
  kind: z.enum(REVENUE_KINDS),
  amount: positiveMoneySchema,
  /** How many paying customers this entry stands for; no personal data (§2.12). */
  customers: z.int().min(0).max(100_000),
  description: text(500),
  receivedAt: timestampSchema,
  allocation: z.strictObject({
    opportunityId: opportunityIdSchema.optional(),
    hypothesisId: hypothesisIdSchema.optional(),
    experimentId: experimentIdSchema.optional(),
  }),
  /** Corrections are new entries (§2.2): a reversal cancels the referenced entry. */
  reversalOf: revenueEntryIdSchema.optional(),
};

/** An immutable line of the revenue ledger (PHASE 16). Money that came in needs no approval. */
export const newRevenueEntrySchema = z.strictObject(newRevenueEntryShape);
export type NewRevenueEntry = z.infer<typeof newRevenueEntrySchema>;

export const revenueEntrySchema = z.object({
  ...newRevenueEntryShape,
  id: revenueEntryIdSchema,
  ...immutableMetaShape,
});
export type RevenueEntry = z.infer<typeof revenueEntrySchema>;

export function recordRevenueEntry(
  data: NewRevenueEntry,
  context: CreateContext<RevenueEntryId>,
): RevenueEntry {
  return parseEntity(revenueEntrySchema, 'revenue_entry', {
    ...data,
    id: context.id,
    ...immutableMeta(context),
  });
}

export interface RevenueSummary {
  readonly payments: Money;
  readonly preorders: Money;
  readonly customers: number;
}

/** Deterministic totals in code (§7.3): reversal entries subtract their amount and customers. */
export function summarizeRevenue(entries: readonly RevenueEntry[]): RevenueSummary {
  let payments = ZERO_USD;
  let preorders = ZERO_USD;
  let customers = 0;
  for (const entry of entries) {
    const sign = entry.reversalOf === undefined ? 1 : -1;
    const apply = sign === 1 ? addMoney : subtractMoney;
    if (entry.kind === 'payment') payments = apply(payments, entry.amount);
    else preorders = apply(preorders, entry.amount);
    customers += sign * entry.customers;
  }
  return { payments, preorders, customers };
}
