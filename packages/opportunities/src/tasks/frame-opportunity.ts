import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import { quoteInText } from '@roi-dealer/signals';

/*
 * PHASE 07: frame a pain as an opportunity (outcome-first, §2.17) and note the features the
 * score and the business model need. The model proposes; code verifies the money quotes against
 * the evidence and computes everything else (§2.3, §2.13).
 */

export const MAX_EXCERPTS = 8;
const EXCERPT_LENGTH = 1_000;

const input = z.strictObject({
  pain: z.strictObject({
    title: z.string().min(1).max(200),
    audience: z.string().min(1).max(1_000),
    desiredOutcome: z.string().min(1).max(1_000),
  }),
  excerpts: z.array(z.string().min(1).max(EXCERPT_LENGTH)).min(1).max(MAX_EXCERPTS),
});
// Every field is required (strict structured output); limits are checked in code.
const output = z.strictObject({
  title: z.string(),
  summary: z.string(),
  icp: z.string(),
  problem: z.string(),
  change: z.string(),
  measurableResult: z.string(),
  buyer: z.enum(['business', 'consumer']),
  recurring: z.boolean(),
  urgency: z.enum(['low', 'medium', 'high']),
  serviceHeavy: z.boolean(),
  paymentQuotes: z.array(z.string()),
  pricingHypothesis: z.string(),
});

export type FrameOpportunityInput = z.infer<typeof input>;
export type FrameOpportunityOutput = z.infer<typeof output>;
export interface FrameOpportunityExpected {
  readonly buyer: 'business' | 'consumer';
  readonly recurring: boolean;
  /** The evidence shows money already spent or lost. */
  readonly paying: boolean;
  readonly excerpts: readonly string[];
}

const MAX_QUOTES = 3;
const MAX_QUOTE = 300;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function bare(quote: string): string {
  return quote
    .trim()
    .replace(/^["'“‘«]+|["'”’»]+$/g, '')
    .trim();
}

/** The distinct money quotes that are really in one of the excerpts, at most three. */
export function verifiedQuotes(quotes: readonly string[], excerpts: readonly string[]): string[] {
  const found = quotes
    .map(bare)
    .filter((quote) => quote.length <= MAX_QUOTE)
    .filter((quote) => excerpts.some((excerpt) => quoteInText(excerpt, quote)));
  // The same quote in another case or spacing counts once: it must not inflate the score.
  const unique = new Map(found.map((quote) => [quote.toLowerCase().replace(/\s+/g, ' '), quote]));
  return [...unique.values()].slice(0, MAX_QUOTES);
}

/** An opportunity the code accepted from the model's answer. */
export interface OpportunityDraft {
  readonly title: string;
  readonly summary: string;
  /** Empty when the model gave none; the caller falls back to the pain's audience. */
  readonly icp: string;
  readonly problem: string;
  readonly change: string;
  readonly measurableResult: string;
  readonly buyer: FrameOpportunityOutput['buyer'];
  readonly recurring: boolean;
  readonly urgency: FrameOpportunityOutput['urgency'];
  readonly serviceHeavy: boolean;
  readonly paymentQuotes: readonly string[];
  readonly pricingHypothesis?: string | undefined;
}

/** Checks the answer: `'rejected'` when the value proposition is incomplete (§2.17). */
export function toOpportunityDraft(
  excerpts: readonly string[],
  answer: FrameOpportunityOutput,
): OpportunityDraft | 'rejected' {
  const title = clip(answer.title, 200);
  const problem = clip(answer.problem, 1_000);
  const change = clip(answer.change, 1_000);
  const measurableResult = clip(answer.measurableResult, 500);
  if (title.length < 10 || problem === '' || change === '' || measurableResult === '') {
    return 'rejected';
  }
  const pricing = clip(answer.pricingHypothesis, 500);
  return {
    title,
    summary: clip(answer.summary, 1_500) || problem,
    icp: clip(answer.icp, 1_000),
    problem,
    change,
    measurableResult,
    buyer: answer.buyer,
    recurring: answer.recurring,
    urgency: answer.urgency,
    serviceHeavy: answer.serviceHeavy,
    paymentQuotes: verifiedQuotes(answer.paymentQuotes, excerpts),
    pricingHypothesis: pricing === '' ? undefined : pricing,
  };
}

type Case = readonly [
  pain: readonly [title: string, audience: string, outcome: string],
  excerpts: readonly string[],
  expected: readonly [buyer: 'business' | 'consumer', recurring: boolean, paying: boolean],
];

const golden: readonly Case[] = [
  [
    [
      'Small agencies struggle to reconcile Stripe payouts with accounting',
      'Small agencies',
      'Books match payouts automatically',
    ],
    [
      "We're a 5-person agency and reconciling Stripe payouts with QuickBooks takes our accountant 6 hours a week.",
      'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
    ],
    ['business', true, true],
  ],
  [
    [
      'Small engineering teams burn out from noisy on-call alerts',
      'Small engineering teams',
      'Only real incidents wake people up',
    ],
    ['We get paged at night for alerts that turn out to be noise and everyone is burning out.'],
    ['business', true, false],
  ],
  [
    [
      'Small companies struggle to move data off a legacy CRM',
      'Small companies',
      'All records moved without loss',
    ],
    [
      'We need to move 8 years of customer records off our old CRM and the vendor wants $5,000 for an export.',
    ],
    ['business', false, true],
  ],
  [
    [
      'Parents struggle to coordinate school pickups with other families',
      'Parents',
      'A clear pickup schedule',
    ],
    [
      "Every week I text five other parents to figure out who drives the kids to school. It's chaos.",
    ],
    ['consumer', true, false],
  ],
  [
    [
      'Homeowners overpay to appeal their property tax assessment',
      'Homeowners',
      'A lower tax bill without a costly firm',
    ],
    ['I paid a firm $600 to appeal my property tax assessment and it took them ten minutes.'],
    ['consumer', false, true],
  ],
  [
    [
      'Dental clinics lose revenue to patient no-shows',
      'Dental clinics',
      'Fewer missed appointments',
    ],
    [
      'Patients no-show about 15% of appointments and the reminder SMS tool we use costs $300/month and still misses half of them.',
    ],
    ['business', true, true],
  ],
  [
    [
      'Online sellers oversell when inventory does not sync between marketplaces',
      'Multichannel e-commerce sellers',
      'Stock always in sync',
    ],
    ["We oversold 40 orders last month because stock didn't sync and had to refund them."],
    ['business', true, true],
  ],
  [
    [
      'Small landlords lose track of tenant maintenance requests',
      'Small landlords',
      'Every repair tracked to done',
    ],
    ['Tenants text me photos at all hours and I keep losing track of which repairs were done.'],
    ['business', true, false],
  ],
  [
    [
      'People get charged for free trials they forget to cancel',
      'Consumers with many app subscriptions',
      'No surprise charges',
    ],
    [
      'I keep forgetting to cancel free trials and last month I got charged $90 for three apps I never used.',
    ],
    ['consumer', true, true],
  ],
  [
    [
      'Freelance designers struggle to get clients to pay invoices on time',
      'Freelance designers',
      'Paid on time without chasing',
    ],
    [
      'Half my clients pay 60+ days late. I spend every Friday sending reminder emails instead of working.',
      'I now pay a virtual assistant $300 a month just to chase invoices.',
    ],
    ['business', true, true],
  ],
  [
    [
      'People moving abroad cannot find out which visa documents they need',
      'People relocating for work',
      'A reliable document checklist',
    ],
    [
      "I'm moving to Canada next year and every website gives a different list of documents for the work visa.",
    ],
    ['consumer', false, false],
  ],
  [
    [
      'Restaurants throw away food because weekday demand is unpredictable',
      'Restaurant owners',
      'Order only what will sell',
    ],
    [
      "Our restaurant throws away about $2,000 of food a month because we can't predict how many customers will come on weekdays.",
    ],
    ['business', true, true],
  ],
  [
    [
      'Founders struggle to choose where to incorporate a startup',
      'Startup founders from abroad',
      'A clear choice of jurisdiction',
    ],
    [
      "We're founders from Ukraine trying to figure out whether to incorporate in Delaware or Estonia and every forum says something different.",
    ],
    ['business', false, false],
  ],
  [
    [
      'Support teams answer the same shipping questions every day',
      'E-commerce support teams',
      'Repetitive questions answered automatically',
    ],
    [
      'Our support inbox gets 400 emails a day and most are the same 10 questions about shipping. We already pay two part-time agents just for these tickets.',
    ],
    ['business', true, true],
  ],
  [
    [
      'Runners cannot find training partners at their pace',
      'Amateur runners',
      'A partner at the same pace nearby',
    ],
    ['I run every morning but can never find anyone near me who runs at my pace.'],
    ['consumer', true, false],
  ],
  [
    [
      'Remote teams struggle to schedule meetings across time zones',
      'Remote teams',
      'Meetings booked in one step',
    ],
    ['Our team spans 9 time zones and finding a meeting slot takes a dozen messages every week.'],
    ['business', true, false],
  ],
  [
    ['Car owners cannot tell whether a repair was needed', 'Car owners', 'Fair repair prices'],
    ['The garage charged me $1,200 for a repair and I had no idea if it was even needed.'],
    ['consumer', false, true],
  ],
  [
    [
      'Companies keep paying for SaaS seats of former contractors',
      'Small companies',
      'Seats removed when people leave',
    ],
    ['We pay for 30 SaaS seats nobody uses because former contractors were never removed.'],
    ['business', true, true],
  ],
  [
    [
      'Pet owners overpay for last-minute pet sitting',
      'Pet owners who travel',
      'Affordable pet care booked ahead',
    ],
    [
      "Every time I travel I end up paying $80 a night for a last-minute pet sitter because I can't plan ahead.",
    ],
    ['consumer', true, true],
  ],
  [
    [
      'Small businesses overpay for a one-time accessibility audit',
      'Small business website owners',
      'An affordable compliant website',
    ],
    [
      'We got a legal letter about website accessibility and an audit firm wants $8,000 for a one-time report.',
    ],
    ['business', false, true],
  ],
];

const cases = golden.map(
  ([[title, audience, desiredOutcome], excerpts, [buyer, recurring, paying]]) => ({
    input: { pain: { title, audience, desiredOutcome }, excerpts: [...excerpts] },
    expected: { buyer, recurring, paying, excerpts },
  }),
);

/** Features right, money quotes verified, value proposition complete — over the golden set. */
export function scoreFrameOpportunity(
  results: readonly {
    readonly expected: FrameOpportunityExpected;
    readonly output: FrameOpportunityOutput | undefined;
  }[],
): EvalScore {
  let buyer = 0;
  let recurring = 0;
  let payment = 0;
  let complete = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    if (answer.buyer === expected.buyer) buyer += 1;
    if (answer.recurring === expected.recurring) recurring += 1;
    const paying = verifiedQuotes(answer.paymentQuotes, expected.excerpts).length > 0;
    if (paying === expected.paying) payment += 1;
    if (toOpportunityDraft(expected.excerpts, answer) !== 'rejected') complete += 1;
  }
  const share = (count: number) => (results.length === 0 ? 0 : count / results.length);
  const metrics = {
    buyer: share(buyer),
    recurring: share(recurring),
    payment: share(payment),
    complete: share(complete),
    answered: share(answered),
  };
  return {
    passed:
      metrics.buyer >= 0.85 &&
      metrics.recurring >= 0.8 &&
      metrics.payment >= 0.8 &&
      metrics.complete >= 0.9 &&
      metrics.answered >= 0.9,
    metrics,
  };
}

export const frameOpportunityTask: AiTask<
  FrameOpportunityInput,
  FrameOpportunityOutput,
  FrameOpportunityExpected
> = {
  name: 'frame-opportunity',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You turn a pain found in public forum posts into a business opportunity, outcome first.',
    'Use only what the posts say; do not invent numbers, markets or competitors.',
    '- title: the opportunity as the result for the customer, one line.',
    '- summary: two or three sentences: who, what hurts, what would change.',
    '- icp: the ideal customer: role or type of business, size, situation.',
    '- problem, change, measurableResult: the problem; what changes for the customer;',
    '  a result they could measure (time, money, errors, customers).',
    '- buyer: business if a company, freelancer or professional would pay; consumer otherwise.',
    '- recurring: true if the problem comes back regularly, false if it happens once.',
    '- urgency: high if it costs money or customers now, medium if clearly painful, low if mild.',
    '- serviceHeavy: true if solving it needs human work for every customer.',
    '- paymentQuotes: words copied exactly from the posts that show money already spent or',
    '  lost because of the problem (fees, paid tools or people, refunds, waste). Empty if none.',
    '- pricingHypothesis: one sentence: what to charge and why, as a hypothesis to test.',
  ].join('\n'),
  input,
  output,
  render: ({ pain, excerpts }) =>
    [
      `Pain: ${pain.title}`,
      `Audience: ${pain.audience}`,
      `Desired outcome: ${pain.desiredOutcome}`,
      '',
      'Posts:',
      ...excerpts.map((excerpt, index) => `${String(index + 1)}. """${excerpt}"""`),
    ].join('\n'),
  maxOutputTokens: 2_048,
  // Worst case: ~9 800 input tokens (eight full excerpts) and 2 048 output on the dearest bulk model.
  maxCostMicroUsd: 20_000,
  // A few pains a day; ~$0.002 a call on the cheapest model.
  dailyShare: 0.1,
  evalCases: cases,
  score: scoreFrameOpportunity,
};
