import {
  toTimestamp,
  usd,
  type Actor,
  type DomainContext,
  type EvidenceId,
  type HypothesisId,
  type NewEvidence,
  type NewExperiment,
  type NewHypothesis,
  type NewOpportunity,
  type NewPain,
  type NewSource,
  type OpportunityId,
  type PainId,
  type SourceId,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';

export const OWNER: Actor = { type: 'owner', id: 'owner' };
export const MEMBER: Actor = { type: 'member', id: 'member-1' };
export const AGENT: Actor = { type: 'agent', id: 'research-agent' };
export const SYSTEM: Actor = { type: 'system', id: 'scheduler' };

const BASE_MS = Date.parse('2026-10-01T10:00:00.000Z');

/** Deterministic UTC timestamp `minutes` after the test epoch. */
export const at = (minutes = 0) => toTimestamp(new Date(BASE_MS + minutes * 60_000));

export const ctx = (actor: Actor = OWNER, minutes = 0): DomainContext => ({
  actor,
  at: at(minutes),
});

/** Create context with a fresh branded UUID v7. */
export function createCtx<Id>(
  idSchema: { parse(value: unknown): Id },
  actor: Actor = OWNER,
  minutes = 0,
) {
  return { id: idSchema.parse(uuidv7()), actor, at: at(minutes) };
}

export function sourceData(overrides: Partial<NewSource> = {}): NewSource {
  return {
    kind: 'forum',
    name: 'r/smallbusiness',
    url: 'https://www.reddit.com/r/smallbusiness',
    markets: ['US'],
    languages: ['en'],
    trust: 'medium',
    ...overrides,
  };
}

export function evidenceData(
  sourceId: SourceId,
  overrides: Partial<NewEvidence> = {},
): NewEvidence {
  return {
    sourceId,
    kind: 'quote',
    excerpt: 'I spend 6 hours every week reconciling invoices by hand.',
    observedAt: at(-60),
    market: 'US',
    language: 'en',
    ...overrides,
  };
}

export function painData(evidenceIds: EvidenceId[], overrides: Partial<NewPain> = {}): NewPain {
  return {
    title: 'Manual invoice reconciliation',
    description: 'Small agencies reconcile invoices and payments manually every week.',
    audience: 'US marketing agencies with 5–50 employees',
    desiredOutcome: 'Reconciliation done in minutes instead of hours',
    severity: 4,
    frequency: 'frequent',
    markets: ['US'],
    signalIds: [],
    evidenceIds,
    ...overrides,
  };
}

export function opportunityData(
  painIds: PainId[],
  overrides: Partial<NewOpportunity> = {},
): NewOpportunity {
  return {
    title: 'Invoice reconciliation assistant for agencies',
    summary: 'Automatic matching of invoices and bank payments for small agencies.',
    painIds,
    icp: 'US agencies, 5–50 people, using QuickBooks',
    markets: ['US'],
    valueProposition: {
      problem: 'Hours lost weekly on manual reconciliation',
      change: 'Payments are matched automatically',
      measurableResult: 'Save 5+ hours per week',
    },
    businessModel: { model: 'subscription', pricingHypothesis: '$49 per month' },
    ...overrides,
  };
}

export function hypothesisData(
  opportunityId: OpportunityId,
  overrides: Partial<NewHypothesis> = {},
): NewHypothesis {
  return {
    opportunityId,
    statement: 'Agency owners will join a waitlist for automatic reconciliation',
    audience: 'Agency owners in the US',
    geo: 'US',
    offer: 'Early access, 50% off for 3 months',
    price: usd(4_900),
    channel: 'LinkedIn ads',
    creative: 'Before/after demo video',
    cta: 'Join the waitlist',
    validationMethod: 'landing_page',
    successMetric: { name: 'waitlist conversion', target: 5, unit: '%', direction: 'at_least' },
    budget: usd(20_000),
    stopLoss: usd(10_000),
    minimumData: '300 unique visitors',
    ...overrides,
  };
}

/** Five hypotheses that differ in how they validate the opportunity. */
export function fiveHypotheses(opportunityId: OpportunityId): NewHypothesis[] {
  return [
    hypothesisData(opportunityId),
    hypothesisData(opportunityId, { validationMethod: 'demo', channel: 'Cold email' }),
    hypothesisData(opportunityId, { validationMethod: 'preorder', price: usd(39_900) }),
    hypothesisData(opportunityId, { validationMethod: 'concierge', geo: 'GB' }),
    hypothesisData(opportunityId, { validationMethod: 'interviews', audience: 'Agency CFOs' }),
  ];
}

export function experimentData(
  opportunityId: OpportunityId,
  hypothesisId: HypothesisId,
  overrides: Partial<NewExperiment> = {},
): NewExperiment {
  return {
    opportunityId,
    hypothesisId,
    artifact: 'landing',
    description: 'Landing page with demo video and waitlist form',
    buildBudget: {
      maxMoney: usd(5_000),
      maxAiCost: usd(1_000),
      maxHumanHours: 6,
      maxCalendarDays: 7,
    },
    testBudget: usd(20_000),
    stopLoss: usd(10_000),
    successMetric: { name: 'waitlist conversion', target: 5, unit: '%', direction: 'at_least' },
    killCriteria: 'Conversion below 1% after 300 visitors',
    expectedEvidence: 'Conversion rate and qualitative replies',
    ...overrides,
  };
}
