import type { AiProvider } from '@roi-dealer/database';

/** `bulk` — high-volume extraction; `strong` — judgement (scores, decisions to propose). */
export const TASK_TIERS = ['bulk', 'strong'] as const;
export type TaskTier = (typeof TASK_TIERS)[number];

/** What a model can do and what it costs (D-012: routing on a capability registry). */
export interface ModelSpec {
  readonly id: string;
  readonly provider: AiProvider;
  readonly tier: TaskTier;
  /** Micro-USD per 1M input / output tokens. */
  readonly inputMicroUsdPerMTok: number;
  readonly outputMicroUsdPerMTok: number;
  readonly contextTokens: number;
  readonly structuredOutput: boolean;
  /** Where the price comes from and when it was checked. */
  readonly priceSource: string;
  readonly checkedOn: string;
}

const USD = 1_000_000;

/**
 * The models each tier may use (ADR-0006, D-021). The order of a task's calls comes from its
 * evals (`routingOrder`); this order only breaks ties. The worker confirms each id with the
 * provider's model list at start; a model the provider does not list is not used.
 */
export const MODEL_REGISTRY: readonly ModelSpec[] = [
  {
    id: 'claude-haiku-5-5',
    provider: 'anthropic',
    tier: 'bulk',
    inputMicroUsdPerMTok: 0.1 * USD,
    outputMicroUsdPerMTok: 0.5 * USD,
    contextTokens: 1_000_000,
    structuredOutput: true,
    priceSource: 'Claude API reference (prompts up to 100K tokens)',
    checkedOn: '2026-10-18',
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    tier: 'bulk',
    inputMicroUsdPerMTok: 0.25 * USD,
    // Thinking tokens are billed as output.
    outputMicroUsdPerMTok: 1.5 * USD,
    contextTokens: 1_000_000,
    structuredOutput: true,
    priceSource: 'Gemini API pricing page (paid tier, text); confirmed by the model list',
    checkedOn: '2026-10-18',
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai',
    tier: 'bulk',
    inputMicroUsdPerMTok: 0.75 * USD,
    outputMicroUsdPerMTok: 4.5 * USD,
    contextTokens: 400_000,
    structuredOutput: true,
    priceSource: 'Third-party price tables (June and October 2026); confirmed by the model list',
    checkedOn: '2026-10-18',
  },
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    tier: 'strong',
    inputMicroUsdPerMTok: 4 * USD,
    outputMicroUsdPerMTok: 20 * USD,
    contextTokens: 1_000_000,
    structuredOutput: true,
    priceSource: 'Claude API reference',
    checkedOn: '2026-10-18',
  },
];

/** Cost of one call in micro-USD, rounded up. */
export function callCostMicroUsd(
  model: Pick<ModelSpec, 'inputMicroUsdPerMTok' | 'outputMicroUsdPerMTok'>,
  inputTokens: number,
  outputTokens: number,
): number {
  return Math.ceil(
    (inputTokens * model.inputMicroUsdPerMTok + outputTokens * model.outputMicroUsdPerMTok) /
      1_000_000,
  );
}

/** A model id as a knowledge tag (`gpt-5.4-mini` → `gpt-5-4-mini`). */
export function modelTag(id: string): string {
  return `model-${id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`.slice(0, 40);
}
