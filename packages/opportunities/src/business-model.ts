import type { MONETIZATION_MODELS } from '@roi-dealer/domain';

/*
 * Business Model Router (PHASE 07): the first monetization hypothesis (§2.18) from the features
 * the AI noted, by a fixed table in code. Alternatives are tested as hypotheses (PHASE 14).
 */

export type MonetizationModel = (typeof MONETIZATION_MODELS)[number];

export interface BusinessFeatures {
  readonly buyer: 'business' | 'consumer';
  /** The problem comes back (weekly, monthly), not once. */
  readonly recurring: boolean;
  readonly urgency: 'low' | 'medium' | 'high';
  /** Solving it needs human work per customer. */
  readonly serviceHeavy: boolean;
}

export const ROUTING_REASONS = {
  service: 'Needs human work per customer: start as a service, automate later',
  business_recurring: 'A business with a recurring problem: recurring value, recurring payment',
  business_once: 'A business with a one-time problem: a one-time purchase',
  consumer_casual: 'A recurring but not urgent consumer problem: a free limit lowers the entry',
  consumer_recurring: 'A recurring consumer problem: recurring value, recurring payment',
  consumer_once: 'A one-time consumer problem: a one-time purchase',
} as const;
export type RoutingReason = keyof typeof ROUTING_REASONS;

export function routeBusinessModel(features: BusinessFeatures): {
  readonly model: MonetizationModel;
  readonly reason: RoutingReason;
} {
  if (features.serviceHeavy) return { model: 'service', reason: 'service' };
  if (features.buyer === 'business') {
    return features.recurring
      ? { model: 'subscription', reason: 'business_recurring' }
      : { model: 'one_time', reason: 'business_once' };
  }
  if (!features.recurring) return { model: 'one_time', reason: 'consumer_once' };
  return features.urgency === 'low'
    ? { model: 'free_limit', reason: 'consumer_casual' }
    : { model: 'subscription', reason: 'consumer_recurring' };
}
