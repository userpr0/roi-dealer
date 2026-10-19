import { z } from 'zod';
import type { KnowledgeAsset } from './entities/knowledge.js';
import { evidenceIdSchema } from './primitives.js';

/*
 * Market context of an opportunity (PHASE 10): a `market_data` entry of the Company Brain whose
 * body holds these structured parameters (§2.20) — what people use now, the money they mention
 * and who pays, each with its quote and the evidence it comes from. The market context agent
 * writes it; the judges and the decision card read it (PHASE 11–12).
 */

/** The tag of market context entries. */
export const MARKET_CONTEXT_TAG = 'market-context';
export const ALTERNATIVE_KINDS = ['product', 'service', 'manual', 'in_house'] as const;
export const MONEY_PERIODS = ['one_time', 'hour', 'week', 'month', 'year', 'unknown'] as const;
export type MoneyPeriod = (typeof MONEY_PERIODS)[number];

const MAX_ITEMS = 5;
const nameSchema = z.string().min(1).max(80);
const quoteSchema = z.string().min(1).max(300);

export const marketContextSchema = z.strictObject({
  version: z.literal(1),
  alternatives: z
    .array(
      z.strictObject({
        name: nameSchema,
        kind: z.enum(ALTERNATIVE_KINDS),
        quote: quoteSchema,
        evidenceId: evidenceIdSchema,
      }),
    )
    .max(MAX_ITEMS),
  money: z
    .array(
      z.strictObject({
        /** Read by code from the quote, never taken from a model (§2.13). */
        amountUsd: z.number().positive().max(1_000_000_000),
        period: z.enum(MONEY_PERIODS),
        quote: quoteSchema,
        evidenceId: evidenceIdSchema,
      }),
    )
    .max(MAX_ITEMS),
  buyers: z
    .array(z.strictObject({ role: nameSchema, quote: quoteSchema, evidenceId: evidenceIdSchema }))
    .max(MAX_ITEMS),
});
export type MarketContextData = z.infer<typeof marketContextSchema>;

/** The structured context of a market context entry; `undefined` for any other asset. */
export function readMarketContext(asset: KnowledgeAsset): MarketContextData | undefined {
  if (
    asset.kind !== 'market_data' ||
    !asset.tags.includes(MARKET_CONTEXT_TAG) ||
    asset.body === undefined
  ) {
    return undefined;
  }
  try {
    const parsed = marketContextSchema.safeParse(JSON.parse(asset.body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
