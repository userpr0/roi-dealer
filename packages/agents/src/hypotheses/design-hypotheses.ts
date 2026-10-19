import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import {
  assertDistinctHypothesisSet,
  DomainError,
  FUNNEL_STAGES,
  funnelMetric,
  HYPOTHESES_PER_OPPORTUNITY,
  isEarlierStage,
  newHypothesisSchema,
  usd,
  VALIDATION_METHODS,
  type NewHypothesis,
  type OpportunityId,
} from '@roi-dealer/domain';

/*
 * PHASE 14: five different ways to test an approved opportunity (§7.1 Step B). The model
 * proposes complete hypotheses; code checks every field and the set — distinct tests, several
 * methods, more than one price, a demo or concierge test, budgets within limits — and asks once
 * for a fix with the list of issues (§2.3). The success metric is a funnel stage, so every test
 * is measured from the same events (PHASE 15, D-014 п.9). Nothing is spent here: experiments
 * start only with the owner's approval (PHASE 15, D-006).
 */

export const MAX_HYPOTHESIS_BUDGET_USD = 100;
export const MAX_SET_BUDGET_USD = 300;
export const MAX_PRICE_USD = 10_000;
export const MIN_METHODS = 3;
export const MIN_PRICES = 2;
/** Methods that show the product or its outcome (SYSTEM_ARCHITECTURE §7, PHASE 14). */
export const DEMO_METHODS = ['demo', 'clickable_prototype', 'concierge'] as const;

const opportunityInput = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1_000),
  icp: z.string().min(1).max(500),
  problem: z.string().min(1).max(500),
  change: z.string().min(1).max(500),
  measurableResult: z.string().min(1).max(300),
  businessModel: z.string().min(1).max(300),
});
const input = z.strictObject({
  opportunity: opportunityInput,
  /** Allowed GEOs (ISO country codes, D-008). */
  markets: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .min(1)
    .max(10),
  excerpts: z.array(z.string().min(1).max(500)).max(4),
  market: z.string().max(1_000),
  judges: z.string().max(1_000),
  /** Issues of the previous answer, for the one fix; empty on the first call. */
  feedback: z.string().max(1_500),
});
const hypothesisOutput = z.strictObject({
  statement: z.string(),
  audience: z.string(),
  geo: z.string(),
  offer: z.string(),
  priceUsd: z.number(),
  channel: z.string(),
  creative: z.string(),
  cta: z.string(),
  validationMethod: z.enum(VALIDATION_METHODS),
  /** A count of `stage`, or (`per` an earlier stage) `stage` as a percentage of `per`. */
  successMetric: z.strictObject({
    stage: z.enum(FUNNEL_STAGES),
    per: z.enum(['none', ...FUNNEL_STAGES]),
    target: z.number(),
  }),
  budgetUsd: z.number(),
  stopLossUsd: z.number(),
  minimumData: z.string(),
});
// Every field is required (strict structured output); limits are checked in code.
const output = z.strictObject({ hypotheses: z.array(hypothesisOutput) });

export type DesignHypothesesInput = z.infer<typeof input>;
export type DesignHypothesesOutput = z.infer<typeof output>;
export interface DesignHypothesesExpected {
  /** Words of the opportunity's customer or problem; a relevant hypothesis mentions one. */
  readonly keys: readonly string[];
  readonly markets: readonly string[];
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

const cents = (amount: number): number => Math.round(amount * 100);

/**
 * The checked set of five hypotheses for the opportunity, or the issues to fix. Every check of
 * §7.1 B and PHASE 14 is here; the domain then validates each hypothesis and the set again.
 */
export function toHypothesisSet(
  opportunityId: OpportunityId,
  markets: readonly string[],
  answer: DesignHypothesesOutput,
): { readonly hypotheses: NewHypothesis[] } | { readonly issues: string[] } {
  const issues: string[] = [];
  if (answer.hypotheses.length < HYPOTHESES_PER_OPPORTUNITY) {
    return {
      issues: [
        `expected ${String(HYPOTHESES_PER_OPPORTUNITY)} hypotheses, got ${String(answer.hypotheses.length)}`,
      ],
    };
  }
  const hypotheses: NewHypothesis[] = [];
  for (const [index, item] of answer.hypotheses.slice(0, HYPOTHESES_PER_OPPORTUNITY).entries()) {
    const at = `hypothesis ${String(index + 1)}`;
    const texts = {
      statement: clip(item.statement, 1_000),
      audience: clip(item.audience, 500),
      offer: clip(item.offer, 500),
      channel: clip(item.channel, 100),
      creative: clip(item.creative, 1_000),
      cta: clip(item.cta, 200),
      minimumData: clip(item.minimumData, 300),
    };
    for (const [field, value] of Object.entries(texts)) {
      if (value === '') issues.push(`${at}: ${field} is empty`);
    }
    const geo = item.geo.trim().toUpperCase();
    if (!markets.includes(geo)) {
      issues.push(`${at}: geo ${geo || '(empty)'} is not one of ${markets.join(', ')}`);
    }
    if (!Number.isFinite(item.priceUsd) || item.priceUsd < 0 || item.priceUsd > MAX_PRICE_USD) {
      issues.push(`${at}: price must be between 0 and ${String(MAX_PRICE_USD)} USD`);
    }
    if (
      !Number.isFinite(item.budgetUsd) ||
      item.budgetUsd < 1 ||
      item.budgetUsd > MAX_HYPOTHESIS_BUDGET_USD
    ) {
      issues.push(`${at}: budget must be between 1 and ${String(MAX_HYPOTHESIS_BUDGET_USD)} USD`);
    }
    if (
      !Number.isFinite(item.stopLossUsd) ||
      item.stopLossUsd < 1 ||
      item.stopLossUsd > item.budgetUsd
    ) {
      issues.push(`${at}: stop-loss must be between 1 USD and the budget`);
    }
    const { stage, per, target } = item.successMetric;
    if (!Number.isFinite(target) || target <= 0) {
      issues.push(`${at}: success metric target must be above 0`);
    }
    if (per !== 'none' && !isEarlierStage(per, stage)) {
      issues.push(`${at}: success metric base ${per} must come before ${stage} in the funnel`);
    } else if (per !== 'none' && target > 100) {
      issues.push(`${at}: a rate target is a percentage, at most 100`);
    }
    const parsed = newHypothesisSchema.safeParse({
      opportunityId,
      statement: texts.statement,
      audience: texts.audience,
      geo,
      offer: texts.offer,
      price: usd(Number.isFinite(item.priceUsd) ? Math.max(cents(item.priceUsd), 0) : 0),
      channel: texts.channel,
      creative: texts.creative,
      cta: texts.cta,
      validationMethod: item.validationMethod,
      successMetric: funnelMetric(
        { stage, per: per === 'none' ? undefined : per },
        Number.isFinite(target) ? target : 0,
      ),
      budget: usd(Number.isFinite(item.budgetUsd) ? Math.max(cents(item.budgetUsd), 1) : 1),
      stopLoss: usd(Number.isFinite(item.stopLossUsd) ? Math.max(cents(item.stopLossUsd), 1) : 1),
      minimumData: texts.minimumData,
    });
    if (parsed.success) hypotheses.push(parsed.data);
    else if (issues.length === 0) issues.push(`${at}: fields are out of range`);
  }
  if (issues.length > 0) return { issues };

  const methods = new Set(hypotheses.map((item) => item.validationMethod));
  if (methods.size < MIN_METHODS) {
    issues.push(`use at least ${String(MIN_METHODS)} different validation methods`);
  }
  if (new Set(hypotheses.map((item) => item.price.amountCents)).size < MIN_PRICES) {
    issues.push(`use at least ${String(MIN_PRICES)} different prices`);
  }
  if (
    !hypotheses.some((item) => (DEMO_METHODS as readonly string[]).includes(item.validationMethod))
  ) {
    issues.push('include a demo, clickable prototype or concierge test');
  }
  const total = hypotheses.reduce((sum, item) => sum + item.budget.amountCents, 0);
  if (total > cents(MAX_SET_BUDGET_USD)) {
    issues.push(`total budget must be at most ${String(MAX_SET_BUDGET_USD)} USD`);
  }
  try {
    assertDistinctHypothesisSet(hypotheses);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    issues.push('two hypotheses are the same test (audience, geo, offer, price, channel, method)');
  }
  return issues.length > 0 ? { issues } : { hypotheses };
}

type Case = readonly [
  title: string,
  icp: string,
  problem: string,
  change: string,
  result: string,
  model: string,
  keys: readonly string[],
];

const golden: readonly Case[] = [
  [
    'Invoices that get paid without chasing',
    'Freelancers and two-person studios',
    'Clients pay invoices late',
    'Reminders and follow-ups run on their own',
    'A day a month back',
    'subscription — $12 a month',
    ['freelanc', 'invoice', 'studio'],
  ],
  [
    'Automatic payout reconciliation for agencies',
    'Agencies with 2–20 people on Stripe',
    'Payouts do not match the books',
    'Payouts are matched automatically',
    'Six hours a week saved',
    'subscription — $49 a month',
    ['agenc', 'payout', 'reconcil', 'bookkeep'],
  ],
  [
    'Builds that fail only for real bugs',
    'Software teams of 5–50 engineers',
    'Flaky tests make teams rerun CI',
    'Flaky tests are detected and quarantined',
    'Half the CI reruns',
    'subscription — $99 a month per team',
    ['engineer', 'team', 'flaky', 'ci', 'developer'],
  ],
  [
    'Fewer patient no-shows for small clinics',
    'Clinics with 1–5 practitioners',
    'Patients miss appointments',
    'Reminders and easy rescheduling by text',
    'Half the no-shows',
    'subscription — $79 a month',
    ['clinic', 'patient', 'no-show', 'practi'],
  ],
  [
    'Sales tax filed without effort',
    'Online sellers in several US states',
    'Sales tax rules are confusing',
    'Filing is prepared automatically',
    'No missed filings',
    'subscription — $29 a month',
    ['seller', 'sales tax', 'tax', 'shop'],
  ],
  [
    'Recover failed card payments',
    'SaaS companies under $1M ARR',
    'Failed payments cause churn',
    'Smart retries and reminders recover them',
    'Recover 30% of failed payments',
    'usage_based — 5% of recovered revenue',
    ['saas', 'founder', 'payment', 'churn'],
  ],
  [
    'Contractors who show up',
    'Homeowners planning repairs',
    'Contractors do not show up',
    'Vetted contractors with a show-up guarantee',
    'Repairs done on the agreed day',
    'service — $25 booking fee',
    ['homeowner', 'contractor', 'repair'],
  ],
  [
    'Essays graded fairly in half the time',
    'High school teachers',
    'Grading essays takes evenings',
    'First-pass feedback is drafted for the teacher',
    'Half the grading time',
    'subscription — $9 a month',
    ['teacher', 'essay', 'grad', 'school'],
  ],
  [
    'Support questions answered without staff',
    'Small e-commerce stores',
    'The same questions flood the inbox',
    'Common questions are answered automatically',
    'Half the support emails',
    'subscription — $39 a month',
    ['store', 'shop', 'support', 'e-commerce', 'ecommerce'],
  ],
  [
    'Client approvals on time',
    'Freelance designers',
    'Clients approve work late',
    'A simple approval page with reminders',
    'Projects finish a week earlier',
    'subscription — $15 a month',
    ['designer', 'freelanc', 'client', 'approv'],
  ],
  [
    'Every donor in one place',
    'Small nonprofits',
    'Donations are tracked in spreadsheets',
    'One simple donor list with receipts',
    'Hours saved every month',
    'free_limit — free up to 100 donors',
    ['nonprofit', 'non-profit', 'donor', 'donation', 'charit'],
  ],
  [
    'No money lost on forgotten subscriptions',
    'Consumers with many subscriptions',
    'People pay for unused subscriptions',
    'Unused subscriptions are found and cancelled',
    '$20 a month saved',
    'subscription — $3 a month',
    ['consumer', 'subscription', 'people', 'user'],
  ],
  [
    'Every billable hour captured',
    'Small law firms',
    'Hours are logged on paper',
    'Time is captured from calendars and email',
    '10% more billable hours',
    'subscription — $30 per lawyer a month',
    ['law', 'lawyer', 'firm', 'attorney', 'legal'],
  ],
  [
    'Supply orders that match what restaurants use',
    'Independent restaurants',
    'Food is ordered by guesswork',
    'Orders are suggested from what was used',
    'Less food thrown away',
    'subscription — $59 a month',
    ['restaurant', 'chef', 'kitchen', 'food'],
  ],
  [
    'Late supplier parts known early',
    'Small manufacturers',
    'Late parts block production',
    'Open orders are tracked and chased',
    'No surprise stoppages',
    'subscription — $149 a month',
    ['manufactur', 'supplier', 'factory', 'production', 'plant'],
  ],
  [
    'Podcast episodes edited in minutes',
    'Independent podcasters',
    'Editing takes hours per episode',
    'Silences and filler words are cut automatically',
    'Episodes ready in minutes',
    'subscription — $19 a month',
    ['podcast', 'creator', 'host'],
  ],
  [
    'Decisions easy to find later',
    'Remote teams of 10–50',
    'Decisions are lost in chat',
    'Decisions are captured from chat into one log',
    'Answers in seconds',
    'subscription — $5 per user a month',
    ['remote', 'team', 'decision', 'manager'],
  ],
  [
    'Rent that arrives on time',
    'Landlords with 1–5 units',
    'Tenants pay rent late',
    'Automatic reminders and easy payment links',
    'Rent on time every month',
    'subscription — $10 per unit a month',
    ['landlord', 'tenant', 'rent', 'propert'],
  ],
  [
    'Stock that matches on every channel',
    'Small online shops on Etsy and Shopify',
    'Shops oversell when stock is out of sync',
    'Stock is synced across channels',
    'No oversold orders',
    'subscription — $25 a month',
    ['shop', 'seller', 'etsy', 'shopify', 'stock', 'inventory'],
  ],
  [
    'Calm on-call for small teams',
    'Engineering teams of 3–10',
    'Noisy alerts wake people at night',
    'Only real incidents page someone',
    'Fewer night pages',
    'subscription — $8 per engineer a month',
    ['engineer', 'team', 'on-call', 'oncall', 'alert', 'devops'],
  ],
];

const cases = golden.map(
  ([title, icp, problem, change, measurableResult, businessModel, keys]) => ({
    input: {
      opportunity: {
        title,
        summary: `${problem}. ${change}.`,
        icp,
        problem,
        change,
        measurableResult,
        businessModel,
      },
      markets: ['US', 'GB'],
      excerpts: [`${problem} — this costs us every week.`],
      market: '',
      judges: 'Judges 70/100; weak spots: none.',
      feedback: '',
    },
    expected: { keys, markets: ['US', 'GB'] },
  }),
);

const OPPORTUNITY_ID = '00000000-0000-7000-8000-000000000000' as OpportunityId;

/** Sets that pass the checks, hypotheses about the customer, valid answers — over the set. */
export function scoreDesignHypotheses(
  results: readonly {
    readonly expected: DesignHypothesesExpected;
    readonly output: DesignHypothesesOutput | undefined;
  }[],
): EvalScore {
  let valid = 0;
  let relevant = 0;
  let hypotheses = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    const checked = toHypothesisSet(OPPORTUNITY_ID, expected.markets, answer);
    if ('issues' in checked) continue;
    valid += 1;
    for (const item of checked.hypotheses) {
      hypotheses += 1;
      const text = `${item.audience} ${item.statement}`.toLowerCase();
      if (expected.keys.some((key) => text.includes(key))) relevant += 1;
    }
  }
  const share = (count: number, total: number) => (total === 0 ? 0 : count / total);
  const metrics = {
    valid: share(valid, results.length),
    relevant: share(relevant, hypotheses),
    answered: share(answered, results.length),
  };
  return {
    passed: metrics.valid >= 0.85 && metrics.relevant >= 0.8 && metrics.answered >= 0.9,
    metrics,
  };
}

export const designHypothesesTask: AiTask<
  DesignHypothesesInput,
  DesignHypothesesOutput,
  DesignHypothesesExpected
> = {
  name: 'design-hypotheses',
  version: 2,
  tier: 'bulk',
  instructions: [
    'You design five cheap, honest market tests for a business opportunity the owner approved.',
    'The five must differ in HOW they test: use at least three validation methods, at least two',
    'different prices, and at least one demo, clickable prototype or concierge test that shows',
    'the outcome. Prefer the smallest product that tests willingness to pay (landing page, demo,',
    'concierge, preorder) over building software.',
    'For each hypothesis:',
    '- statement: "If we offer X to Y through Z, at least N will do W", one sentence.',
    '- audience: the exact customer; geo: one of the allowed country codes.',
    '- offer, priceUsd (0 for a free waitlist), channel (where people see it), creative (what',
    '  they see: the headline and the promised measurable result, no invented reviews or numbers),',
    '  cta (the action asked).',
    '- validationMethod; successMetric: the funnel stage that shows success (impression,',
    '  attention, cta_click, activation, lead = sign-up or trial, payment, product_use, outcome,',
    '  retention); per: "none" for a count of that stage, or an earlier stage to measure a',
    '  percentage of it; target above 0 (a percentage at most 100).',
    '- budgetUsd between 1 and 100 (money for ads and tools), stopLossUsd between 1 and the',
    '  budget, all five together at most 300; minimumData: the data needed before judging.',
    'Be honest: a fake-door page says "coming soon"; a preorder states the delivery date and',
    'refund. If feedback lists issues of a previous answer, fix all of them.',
  ].join('\n'),
  input,
  output,
  render: ({ opportunity, markets, excerpts, market, judges, feedback }) =>
    [
      `Opportunity: ${opportunity.title}`,
      `Summary: ${opportunity.summary}`,
      `Customer: ${opportunity.icp}`,
      `Problem: ${opportunity.problem}`,
      `Change: ${opportunity.change}`,
      `Measurable result: ${opportunity.measurableResult}`,
      `Business model: ${opportunity.businessModel}`,
      `Allowed geo: ${markets.join(', ')}`,
      `Market context: ${market === '' ? 'none collected' : market}`,
      `Judges: ${judges === '' ? 'none' : judges}`,
      ...(excerpts.length === 0
        ? []
        : [
            'Posts:',
            ...excerpts.map((excerpt, index) => `E${String(index + 1)}. """${excerpt}"""`),
          ]),
      ...(feedback === '' ? [] : ['', `Fix these issues of your previous answer: ${feedback}`]),
    ].join('\n'),
  maxOutputTokens: 3_000,
  // Worst case: ~11 000 input tokens (every field full) and 3 000 output on the dearest bulk
  // model.
  maxCostMicroUsd: 25_000,
  // One or two calls per approved opportunity: approvals are rare.
  dailyShare: 0.05,
  evalCases: cases,
  score: scoreDesignHypotheses,
};
