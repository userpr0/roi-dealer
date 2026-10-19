import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import { PRICE_PERIODS, usd, VALIDATION_METHODS, type Hypothesis } from '@roi-dealer/domain';
import { landingDisclosure, toLandingContent } from './landing.js';

type ValidationMethod = Hypothesis['validationMethod'];

/*
 * PHASE 19a: the landing page of a test and three ad texts, written from the hypothesis and
 * the opportunity (§7.1 Step C). The model writes words; code checks them (`toLandingContent`)
 * and sets the price and the honesty note. The owner approves or rejects the page (D-012).
 */

const opportunityInput = z.strictObject({
  title: z.string().min(1).max(200),
  icp: z.string().min(1).max(500),
  problem: z.string().min(1).max(500),
  change: z.string().min(1).max(500),
  measurableResult: z.string().min(1).max(300),
});
const hypothesisInput = z.strictObject({
  audience: z.string().min(1).max(500),
  offer: z.string().min(1).max(500),
  priceUsd: z.number().min(0).max(10_000),
  channel: z.string().min(1).max(100),
  creative: z.string().min(1).max(1_000),
  cta: z.string().min(1).max(200),
  method: z.enum(VALIDATION_METHODS),
});
const input = z.strictObject({
  opportunity: opportunityInput,
  hypothesis: hypothesisInput,
  /** The headline of a page the owner rejected: write a different one; empty on the first. */
  rejectedHeadline: z.string().max(200),
  /** Issues of the previous answer, for the one fix; empty on the first call. */
  feedback: z.string().max(1_500),
});
// Every field is required (strict structured output); lengths and counts are checked in code.
const output = z.strictObject({
  headline: z.string(),
  subheadline: z.string(),
  problem: z.string(),
  benefits: z.array(z.strictObject({ title: z.string(), text: z.string() })),
  steps: z.array(z.string()),
  offer: z.string(),
  pricePeriod: z.enum(PRICE_PERIODS),
  cta: z.string(),
  faq: z.array(z.strictObject({ question: z.string(), answer: z.string() })),
  ads: z.array(z.strictObject({ headline: z.string(), body: z.string() })),
});

export type WriteLandingInput = z.infer<typeof input>;
export type WriteLandingOutput = z.infer<typeof output>;
export interface WriteLandingExpected {
  /** Words of the customer or problem; a relevant headline or subheadline has one. */
  readonly keys: readonly string[];
  /** The case's input, so the answer is checked as the agent checks it. */
  readonly material: WriteLandingInput;
}

/** The input text that money and result numbers of the page may come from (§2.13). */
export function landingSource(value: WriteLandingInput): string {
  const { opportunity, hypothesis } = value;
  return [
    opportunity.problem,
    opportunity.change,
    opportunity.measurableResult,
    hypothesis.offer,
    hypothesis.creative,
  ].join(' \n ');
}

/** The checked page of an answer, as the agent stores it. */
export function checkLanding(value: WriteLandingInput, answer: WriteLandingOutput) {
  return toLandingContent(answer, {
    price: usd(Math.round(value.hypothesis.priceUsd * 100)),
    disclosure: landingDisclosure(value.hypothesis.method),
    source: landingSource(value),
  });
}

type Case = readonly [
  title: string,
  icp: string,
  problem: string,
  change: string,
  result: string,
  method: ValidationMethod,
  priceUsd: number,
  offer: string,
  channel: string,
  keys: readonly string[],
];

const golden: readonly Case[] = [
  [
    'Invoices that get paid without chasing',
    'Freelancers and two-person studios',
    'Clients pay invoices late',
    'Reminders and follow-ups run on their own',
    'A day a month back',
    'waitlist',
    12,
    'Automatic invoice reminders, $12 a month',
    'Reddit r/freelance',
    ['freelanc', 'invoice', 'studio', 'paid', 'client'],
  ],
  [
    'Automatic payout reconciliation for agencies',
    'Agencies with 2–20 people on Stripe',
    'Payouts do not match the books',
    'Payouts are matched automatically',
    'Six hours a week saved',
    'preorder',
    49,
    'Reconciliation that runs itself, $49 a month',
    'LinkedIn ads',
    ['agenc', 'payout', 'reconcil', 'books', 'stripe'],
  ],
  [
    'Builds that fail only for real bugs',
    'Software teams of 5–50 engineers',
    'Flaky tests make teams rerun CI',
    'Flaky tests are detected and quarantined',
    'Half the CI reruns',
    'landing_page',
    99,
    'Flaky test detection for $99 a month per team',
    'Hacker News',
    ['engineer', 'team', 'flaky', 'ci', 'test', 'build'],
  ],
  [
    'Fewer patient no-shows for small clinics',
    'Clinics with 1–5 practitioners',
    'Patients miss appointments',
    'Reminders and easy rescheduling by text',
    'Half the no-shows',
    'waitlist',
    79,
    'Text reminders for clinics, $79 a month',
    'Google search ads',
    ['clinic', 'patient', 'no-show', 'appointment', 'practi'],
  ],
  [
    'Sales tax filed without effort',
    'Online sellers in several US states',
    'Sales tax rules are confusing',
    'Filing is prepared automatically',
    'No missed filings',
    'ads_test',
    29,
    'Sales tax filing prepared for you, $29 a month',
    'Facebook ads',
    ['seller', 'sales tax', 'tax', 'filing', 'shop'],
  ],
  [
    'Recover failed card payments',
    'SaaS companies under $1M ARR',
    'Failed payments cause churn',
    'Smart retries and reminders recover them',
    'Recover 30% of failed payments',
    'preorder',
    39,
    'Failed payment recovery, $39 a month',
    'Indie Hackers',
    ['saas', 'payment', 'churn', 'revenue', 'recover'],
  ],
  [
    'Contractors who show up',
    'Homeowners planning repairs',
    'Contractors do not show up',
    'Vetted contractors with a show-up commitment',
    'Repairs done on the agreed day',
    'waitlist',
    25,
    'A $25 booking fee for a vetted contractor',
    'Nextdoor',
    ['homeowner', 'contractor', 'repair', 'home'],
  ],
  [
    'Essays graded fairly in half the time',
    'High school teachers',
    'Grading essays takes evenings',
    'First-pass feedback is drafted for the teacher',
    'Half the grading time',
    'landing_page',
    9,
    'Essay feedback drafts, $9 a month',
    'Teacher Facebook groups',
    ['teacher', 'essay', 'grad', 'school', 'feedback'],
  ],
  [
    'Support questions answered without staff',
    'Small e-commerce stores',
    'The same questions flood the inbox',
    'Common questions are answered automatically',
    'Half the support emails',
    'ads_test',
    39,
    'Automatic answers to common questions, $39 a month',
    'Shopify community',
    ['store', 'shop', 'support', 'question', 'inbox', 'e-commerce', 'ecommerce'],
  ],
  [
    'Client approvals on time',
    'Freelance designers',
    'Clients approve work late',
    'A simple approval page with reminders',
    'Projects finish a week earlier',
    'waitlist',
    15,
    'Approval pages with reminders, $15 a month',
    'Dribbble',
    ['designer', 'freelanc', 'client', 'approv', 'project'],
  ],
  [
    'Every donor in one place',
    'Small nonprofits',
    'Donations are tracked in spreadsheets',
    'One simple donor list with receipts',
    'Hours saved every month',
    'landing_page',
    0,
    'Free donor list for up to 100 donors',
    'Nonprofit newsletters',
    ['nonprofit', 'non-profit', 'donor', 'donation', 'charit'],
  ],
  [
    'No money lost on forgotten subscriptions',
    'Consumers with many subscriptions',
    'People pay for unused subscriptions',
    'Unused subscriptions are found and cancelled',
    '$20 a month saved',
    'ads_test',
    3,
    'Subscription cleanup for $3 a month',
    'TikTok ads',
    ['subscription', 'money', 'pay', 'unused', 'cancel'],
  ],
  [
    'Every billable hour captured',
    'Small law firms',
    'Hours are logged on paper',
    'Time is captured from calendars and email',
    '10% more billable hours',
    'preorder',
    30,
    'Time capture for $30 per lawyer a month',
    'Legal forums',
    ['law', 'lawyer', 'firm', 'attorney', 'billable', 'legal'],
  ],
  [
    'Supply orders that match what restaurants use',
    'Independent restaurants',
    'Food is ordered by guesswork',
    'Orders are suggested from what was used',
    'Less food thrown away',
    'waitlist',
    59,
    'Order suggestions for $59 a month',
    'Restaurant owner groups',
    ['restaurant', 'chef', 'kitchen', 'food', 'order', 'waste'],
  ],
  [
    'Late supplier parts known early',
    'Small manufacturers',
    'Late parts block production',
    'Open orders are tracked and chased',
    'No surprise stoppages',
    'landing_page',
    149,
    'Supplier order tracking, $149 a month',
    'LinkedIn ads',
    ['manufactur', 'supplier', 'part', 'production', 'factory'],
  ],
  [
    'Podcast episodes edited in minutes',
    'Independent podcasters',
    'Editing takes hours per episode',
    'Silences and filler words are cut automatically',
    'Episodes ready in minutes',
    'preorder',
    19,
    'Automatic podcast editing, $19 a month',
    'Podcasting subreddits',
    ['podcast', 'episode', 'edit', 'creator'],
  ],
  [
    'Decisions easy to find later',
    'Remote teams of 10–50',
    'Decisions are lost in chat',
    'Decisions are captured from chat into one log',
    'Answers in seconds',
    'waitlist',
    5,
    'A decision log from chat, $5 per user a month',
    'Product Hunt',
    ['remote', 'team', 'decision', 'chat'],
  ],
  [
    'Rent that arrives on time',
    'Landlords with 1–5 units',
    'Tenants pay rent late',
    'Automatic reminders and easy payment links',
    'Rent on time every month',
    'landing_page',
    10,
    'Rent reminders, $10 per unit a month',
    'Landlord forums',
    ['landlord', 'tenant', 'rent', 'propert'],
  ],
  [
    'Stock that matches on every channel',
    'Small online shops on Etsy and Shopify',
    'Shops oversell when stock is out of sync',
    'Stock is synced across channels',
    'No oversold orders',
    'ads_test',
    25,
    'Stock sync for $25 a month',
    'Etsy seller forums',
    ['shop', 'seller', 'etsy', 'shopify', 'stock', 'inventory', 'oversell'],
  ],
  [
    'Calm on-call for small teams',
    'Engineering teams of 3–10',
    'Noisy alerts wake people at night',
    'Only real incidents page someone',
    'Fewer night pages',
    'preorder',
    8,
    'Quiet on-call for $8 per engineer a month',
    'DevOps newsletters',
    ['engineer', 'team', 'on-call', 'oncall', 'alert', 'night', 'incident'],
  ],
];

const cases = golden
  .map(
    ([title, icp, problem, change, measurableResult, method, priceUsd, offer, channel, keys]) => ({
      keys,
      input: {
        opportunity: { title, icp, problem, change, measurableResult },
        hypothesis: {
          audience: icp,
          offer,
          priceUsd,
          channel,
          creative: `Headline about ${measurableResult.toLowerCase()} for ${icp.toLowerCase()}`,
          cta: method === 'preorder' ? 'Preorder now' : 'Join the waitlist',
          method,
        },
        rejectedHeadline: '',
        feedback: '',
      },
    }),
  )
  .map((item) => ({ ...item, expected: { keys: item.keys, material: item.input } }));

/** Pages that pass the checks, headlines about the customer, answers received — over the set. */
export function scoreWriteLanding(
  results: readonly {
    readonly expected: WriteLandingExpected;
    readonly output: WriteLandingOutput | undefined;
  }[],
): EvalScore {
  let valid = 0;
  let relevant = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    const checked = checkLanding(expected.material, answer);
    if ('issues' in checked) continue;
    valid += 1;
    const text = `${checked.content.headline} ${checked.content.subheadline}`.toLowerCase();
    if (expected.keys.some((key) => text.includes(key))) relevant += 1;
  }
  const share = (count: number, total: number) => (total === 0 ? 0 : count / total);
  const metrics = {
    valid: share(valid, results.length),
    relevant: share(relevant, valid),
    answered: share(answered, results.length),
  };
  return {
    passed: metrics.valid >= 0.85 && metrics.relevant >= 0.8 && metrics.answered >= 0.9,
    metrics,
  };
}

export const writeLandingTask: AiTask<WriteLandingInput, WriteLandingOutput, WriteLandingExpected> =
  {
    name: 'write-landing',
    version: 1,
    tier: 'bulk',
    instructions: [
      'You write the landing page of a cheap, honest market test, and three short ads for it.',
      'The reader is the customer named in the input. Speak to their problem and the measurable',
      'result they get, in plain English, short sentences, no jargon, no hype.',
      'Write:',
      '- headline (at most 90 characters): the outcome for this customer, not the technology;',
      '- subheadline (at most 200): who it is for and what changes;',
      '- problem (at most 300): the pain in the customer’s words;',
      '- exactly 3 benefits: title (at most 60) and text (at most 160);',
      '- exactly 3 steps of how it works (at most 140 each);',
      '- offer (at most 200): what they get, without the price number;',
      '- pricePeriod: one_time, per_month, per_year or per_user_month, as the offer says;',
      '- cta (at most 40): the button, the action the hypothesis asks for;',
      '- 2 to 4 FAQ: question (at most 120) and answer (at most 300);',
      '- exactly 3 ads for the channel: headline (at most 60) and body (at most 150).',
      'Honesty rules (the page is checked and rejected otherwise):',
      '- no reviews, testimonials, user counts, ratings, awards or "trusted by";',
      '- no guarantees, "risk-free", scarcity or deadlines; no "#1" or "best";',
      '- no prices or money amounts (the page shows the price itself), and no numbers about',
      '  results unless the input gives them; never invent a number;',
      '- no links, emails or phone numbers; English only.',
      'The product does not exist yet: say "join the waitlist" or "preorder", never that people',
      'already use it. If a rejected headline is given, write a clearly different one. If',
      'feedback lists issues of a previous answer, fix all of them.',
    ].join('\n'),
    input,
    output,
    render: ({ opportunity, hypothesis, rejectedHeadline, feedback }) =>
      [
        `Opportunity: ${opportunity.title}`,
        `Customer: ${opportunity.icp}`,
        `Problem: ${opportunity.problem}`,
        `Change: ${opportunity.change}`,
        `Measurable result: ${opportunity.measurableResult}`,
        `Audience of this test: ${hypothesis.audience}`,
        `Offer: ${hypothesis.offer}`,
        `Price shown by the page: ${hypothesis.priceUsd === 0 ? 'free' : `${String(hypothesis.priceUsd)} USD`}`,
        `Test method: ${hypothesis.method}`,
        `Channel of the ads: ${hypothesis.channel}`,
        `Creative idea: ${hypothesis.creative}`,
        `Call to action: ${hypothesis.cta}`,
        ...(rejectedHeadline === ''
          ? []
          : ['', `The owner rejected a page with the headline: ${rejectedHeadline}`]),
        ...(feedback === '' ? [] : ['', `Fix these issues of your previous answer: ${feedback}`]),
      ].join('\n'),
    maxOutputTokens: 2_500,
    // Worst case: ~10 000 input tokens (every field full) and 2 500 output on the dearest bulk
    // model.
    maxCostMicroUsd: 25_000,
    // One or two calls per landing test: tests are rare.
    dailyShare: 0.03,
    evalCases: cases.map(({ input, expected }) => ({ input, expected })),
    score: scoreWriteLanding,
  };
