import type { CountryCode } from './primitives.js';

/** D-008: start with high-paying English-speaking markets. */
export const TARGET_MARKETS: readonly CountryCode[] = ['US', 'GB', 'CA', 'AU'];

/** Whether any of the markets is one of the target markets of D-008. */
export function inTargetMarkets(markets: readonly CountryCode[]): boolean {
  return markets.some((market) => TARGET_MARKETS.includes(market));
}
