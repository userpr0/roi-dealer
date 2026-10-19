import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import { ALTERNATIVE_KINDS, MONEY_PERIODS, type MoneyPeriod } from '@roi-dealer/domain';
import { quoteInText } from '@roi-dealer/signals';

/*
 * PHASE 10: the market around an opportunity, from its evidence only (§2.5): what people use
 * now, the money they mention and who pays. The model points at quotes; code keeps an item only
 * when its quote is in the excerpt it names, and reads every amount from the quote itself
 * (§2.13). Market sizes and competitors from the model's memory are not asked for.
 */

export const MAX_MARKET_EXCERPTS = 12;
const EXCERPT_LENGTH = 1_000;
const MAX_ITEMS = 5;
const MAX_NAME = 80;

const input = z.strictObject({
  opportunity: z.strictObject({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1_000),
    icp: z.string().min(1).max(1_000),
  }),
  excerpts: z.array(z.string().min(1).max(EXCERPT_LENGTH)).min(1).max(MAX_MARKET_EXCERPTS),
});
// Every field is required (strict structured output); limits are checked in code.
const output = z.strictObject({
  alternatives: z.array(
    z.strictObject({
      name: z.string(),
      kind: z.enum(ALTERNATIVE_KINDS),
      quote: z.string(),
      excerpt: z.int(),
    }),
  ),
  money: z.array(
    z.strictObject({ period: z.enum(MONEY_PERIODS), quote: z.string(), excerpt: z.int() }),
  ),
  buyers: z.array(z.strictObject({ role: z.string(), quote: z.string(), excerpt: z.int() })),
});

export type MarketContextInput = z.infer<typeof input>;
export type MarketContextOutput = z.infer<typeof output>;
export interface MarketContextExpected {
  /** Groups of names: a group is found when one name is in a verified alternative. */
  readonly alternatives: readonly (readonly string[])[];
  /** The amounts in USD that must be read from the quotes; empty when none is mentioned. */
  readonly amounts: readonly number[];
  readonly excerpts: readonly string[];
}

/** A market item the code accepted; `excerpt` is the index into the excerpts given. */
export interface MarketContext {
  readonly alternatives: readonly {
    readonly name: string;
    readonly kind: (typeof ALTERNATIVE_KINDS)[number];
    readonly quote: string;
    readonly excerpt: number;
  }[];
  readonly money: readonly {
    readonly amountUsd: number;
    readonly period: MoneyPeriod;
    readonly quote: string;
    readonly excerpt: number;
  }[];
  readonly buyers: readonly {
    readonly role: string;
    readonly quote: string;
    readonly excerpt: number;
  }[];
}

const MULTIPLIERS: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };

/** The first amount in US dollars written in a text: `$400`, `$1,200`, `$14.99`, `$25k`. */
export function parseUsd(text: string): number | undefined {
  const match = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?([km])?(?![a-z])/i.exec(text);
  if (match === null) return undefined;
  const [, whole = '0', fraction = '', suffix = ''] = match;
  const value =
    Number(whole.replace(/,/g, '') + fraction) * (MULTIPLIERS[suffix.toLowerCase()] ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined;
}

const PERIOD_RULES: readonly (readonly [RegExp, MoneyPeriod])[] = [
  [/per hour|an hour|\/\s?h(ou)?r\b|hourly/i, 'hour'],
  [/per week|a week|\/\s?w(ee)?k\b|weekly|every week/i, 'week'],
  [/per month|a month|\/\s?mo(nth)?\b|monthly|every month|each month/i, 'month'],
  [/per year|a year|\/\s?y(ea)?r\b|yearly|annual|per annum/i, 'year'],
];

/** The period written in the quote; otherwise the one the model chose. */
export function periodOf(quote: string, proposed: MoneyPeriod): MoneyPeriod {
  return PERIOD_RULES.find(([pattern]) => pattern.test(quote))?.[1] ?? proposed;
}

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

/** The quote's excerpt index (0-based) when the quote is really in the excerpt it names. */
function verified(
  excerpts: readonly string[],
  item: { readonly quote: string; readonly excerpt: number },
): { readonly quote: string; readonly excerpt: number } | undefined {
  const index = item.excerpt - 1;
  const text = excerpts[index];
  const quote = bare(item.quote);
  if (text === undefined || quote.length > 300 || !quoteInText(text, quote)) return undefined;
  return { quote, excerpt: index };
}

/** Checks the answer: only items whose quote is in the named excerpt, amounts from the quote. */
export function toMarketContext(
  excerpts: readonly string[],
  answer: MarketContextOutput,
): MarketContext {
  const names = new Set<string>();
  const alternatives: MarketContext['alternatives'][number][] = [];
  for (const item of answer.alternatives.slice(0, MAX_ITEMS)) {
    const name = clip(item.name, MAX_NAME);
    const found = verified(excerpts, item);
    if (name === '' || found === undefined || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    alternatives.push({ name, kind: item.kind, ...found });
  }
  const money: MarketContext['money'][number][] = [];
  for (const item of answer.money.slice(0, MAX_ITEMS)) {
    const found = verified(excerpts, item);
    const amountUsd = found === undefined ? undefined : parseUsd(found.quote);
    if (found === undefined || amountUsd === undefined) continue;
    money.push({ amountUsd, period: periodOf(found.quote, item.period), ...found });
  }
  const buyers: MarketContext['buyers'][number][] = [];
  for (const item of answer.buyers.slice(0, MAX_ITEMS)) {
    const role = clip(item.role, MAX_NAME);
    const found = verified(excerpts, item);
    if (role === '' || found === undefined) continue;
    buyers.push({ role, ...found });
  }
  return { alternatives, money, buyers };
}

export function isEmptyContext(context: MarketContext): boolean {
  return (
    context.alternatives.length === 0 && context.money.length === 0 && context.buyers.length === 0
  );
}

const PERIOD_TEXT: Readonly<Record<MoneyPeriod, string>> = {
  one_time: '',
  hour: ' an hour',
  week: ' a week',
  month: ' a month',
  year: ' a year',
  unknown: '',
};

export function formatUsd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount.toLocaleString('en-US')}` : `$${amount.toFixed(2)}`;
}

/** The context in a few lines for people (and the full-text search). */
export function marketSummary(context: MarketContext): string {
  const lines: string[] = [];
  if (context.alternatives.length > 0) {
    lines.push(
      `Alternatives in use: ${context.alternatives.map((item) => `${item.name} (${item.kind.replace('_', '-')})`).join('; ')}.`,
    );
  }
  if (context.money.length > 0) {
    lines.push(
      `Money mentioned: ${context.money.map((item) => `${formatUsd(item.amountUsd)}${PERIOD_TEXT[item.period]}`).join('; ')}.`,
    );
  }
  if (context.buyers.length > 0) {
    lines.push(`Who pays or decides: ${context.buyers.map((item) => item.role).join('; ')}.`);
  }
  return lines.join('\n');
}

type Case = readonly [
  opportunity: readonly [title: string, icp: string],
  excerpts: readonly string[],
  alternatives: readonly (readonly string[])[],
  amounts: readonly number[],
];

const golden: readonly Case[] = [
  [
    ['Automatic payout reconciliation for small agencies', 'Agencies with 2–20 people'],
    [
      'We export Stripe payouts to a Google Sheet and our bookkeeper matches them in QuickBooks every Friday.',
      'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
    ],
    [['sheet', 'spreadsheet'], ['bookkeeper']],
    [400],
  ],
  [
    ['Calm on-call for small engineering teams', 'Engineering teams of 3–10'],
    [
      'We tried PagerDuty but at $41 per user per month it was too much for a team of four.',
      'Right now we just have a shared Slack channel and whoever sees the alert first handles it.',
    ],
    [['pagerduty'], ['slack']],
    [41],
  ],
  [
    ['Invoices that get paid without chasing', 'Freelancers and small studios'],
    [
      'I use FreshBooks reminders but clients ignore them.',
      'I lose about $2,000 a year to clients who never pay.',
    ],
    [['freshbooks']],
    [2_000],
  ],
  [
    ['Rent that arrives on time for small landlords', 'Landlords with 1–5 units'],
    [
      "I collect rent through Venmo and chase people over text when it's late.",
      'Property management companies want 8-10% of rent, which kills my margin on two units.',
    ],
    [['venmo'], ['property manag']],
    [],
  ],
  [
    ['Reliable after-school pickups for working parents', 'Working parents'],
    [
      'We pay a sitter $25 an hour for pickups, and she cancels half the time.',
      'Care.com was full of people who never replied.',
    ],
    [['sitter'], ['care.com', 'care com']],
    [25],
  ],
  [
    ['Stock that matches on every sales channel', 'Small online shops'],
    [
      'We update stock in a spreadsheet at night and still oversell on Etsy.',
      'The sync apps want $99/mo which is more than we make some months.',
    ],
    [['spreadsheet'], ['sync app']],
    [99],
  ],
  [
    ['Podcast episodes edited in minutes', 'Independent podcasters'],
    [
      'I pay an editor $150 per episode.',
      'Descript helped a bit but I still spend three hours per show.',
    ],
    [['editor'], ['descript']],
    [150],
  ],
  [
    ['Decisions that are easy to find later', 'Remote teams of 10–50'],
    [
      'We tried Notion for decision logs but nobody keeps it updated.',
      'Mostly we scroll back through Slack threads to find what we agreed.',
    ],
    [['notion'], ['slack']],
    [],
  ],
  [
    ['Fewer patient no-shows for small clinics', 'Clinics with 1–5 practitioners'],
    [
      'Our front desk calls every patient the day before, which takes two hours a day.',
      'Each no-show costs us around $200 in lost revenue.',
    ],
    [['front desk', 'call']],
    [200],
  ],
  [
    ['Sales tax filed without effort for small sellers', 'Online sellers in several US states'],
    [
      'TaxJar would cost us $1,200 a year, so I do the filings myself in Excel.',
      'Our accountant charges $300 per state filing.',
    ],
    [['taxjar'], ['excel'], ['accountant']],
    [1_200, 300],
  ],
  [
    ['Recover failed card payments for small SaaS', 'SaaS companies under $1M ARR'],
    [
      "Stripe's built-in retries recover some, but we still lose about 5% of MRR.",
      'Churnkey wanted $250 a month which is too much for us.',
    ],
    [['stripe', 'retries'], ['churnkey']],
    [250],
  ],
  [
    ['Repairs done by contractors who show up', 'Homeowners'],
    [
      'I found my last plumber through Nextdoor and he never showed up.',
      'Angi charges contractors for leads so the good ones avoid it.',
    ],
    [['nextdoor'], ['angi']],
    [],
  ],
  [
    ['Essays graded fairly in half the time', 'High school teachers'],
    [
      'I grade 120 essays a week by hand with a rubric in Google Docs.',
      "Our school won't pay for Turnitin's feedback tools.",
    ],
    [['google docs', 'rubric', 'by hand'], ['turnitin']],
    [],
  ],
  [
    ['Common support questions answered without staff', 'Small e-commerce stores'],
    [
      'We answer the same shipping questions in Gmail all day.',
      'Zendesk is $55 per agent per month and we have three people.',
    ],
    [['gmail'], ['zendesk']],
    [55],
  ],
  [
    ['Builds that fail only for real bugs', 'Software teams'],
    [
      'We just retry the CI job up to three times and hope.',
      'We pay $500 a month for extra CI minutes, mostly reruns.',
    ],
    [['retry', 'rerun']],
    [500],
  ],
  [
    ['Client approvals on time for freelance designers', 'Freelance designers'],
    ['I send PDFs over email and wait.', "Clients don't want to learn Figma comments."],
    [['email', 'pdf'], ['figma']],
    [],
  ],
  [
    ['Every donation and donor in one place', 'Small nonprofits'],
    [
      'We track donors in an Excel file that three people edit.',
      'Salesforce Nonprofit was too complex and the consultant quoted $8,000 to set it up.',
    ],
    [['excel'], ['salesforce']],
    [8_000],
  ],
  [
    ['No money lost on forgotten subscriptions', 'Consumers with many subscriptions'],
    [
      "I found I was paying $14.99 a month for an app I hadn't opened in a year.",
      'Rocket Money wants a cut of what it saves you.',
    ],
    [['rocket money']],
    [14.99],
  ],
  [
    ['Every billable hour captured for small law firms', 'Law firms with 2–15 lawyers'],
    [
      'Our lawyers write their hours on paper and the paralegal types them into Clio.',
      'We estimate we lose 10% of billable time.',
    ],
    [['paper'], ['clio']],
    [],
  ],
  [
    ['Supply orders that match what restaurants use', 'Independent restaurants'],
    [
      'The chef orders from memory and we throw out about $300 of produce a week.',
      'We tried MarketMan but it was too much data entry.',
    ],
    [['memory', 'chef'], ['marketman']],
    [300],
  ],
  [
    ['Late supplier parts known before they block production', 'Small manufacturers'],
    [
      'Our buyer keeps a whiteboard of open purchase orders and calls suppliers every morning.',
      'An ERP like NetSuite is $25k a year, way beyond us.',
    ],
    [['whiteboard'], ['netsuite', 'erp']],
    [25_000],
  ],
];

const cases = golden.map(([[title, icp], excerpts, alternatives, amounts]) => ({
  input: {
    opportunity: { title, summary: title, icp },
    excerpts: [...excerpts],
  },
  expected: { alternatives, amounts, excerpts },
}));

/** Alternatives found, amounts right, nothing unquoted — over the golden set. */
export function scoreMarketContext(
  results: readonly {
    readonly expected: MarketContextExpected;
    readonly output: MarketContextOutput | undefined;
  }[],
): EvalScore {
  let recall = 0;
  let recallCases = 0;
  let money = 0;
  let proposed = 0;
  let kept = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (expected.alternatives.length > 0) recallCases += 1;
    if (answer === undefined) continue;
    answered += 1;
    const context = toMarketContext(expected.excerpts, answer);
    const names = context.alternatives.map((item) => item.name.toLowerCase());
    if (expected.alternatives.length > 0) {
      const found = expected.alternatives.filter((group) =>
        group.some((name) => names.some((candidate) => candidate.includes(name))),
      ).length;
      recall += found / expected.alternatives.length;
    }
    const amounts = new Set(context.money.map((item) => item.amountUsd));
    if (
      expected.amounts.every((amount) => amounts.has(amount)) &&
      (expected.amounts.length > 0 || amounts.size === 0)
    ) {
      money += 1;
    }
    proposed += answer.alternatives.length + answer.money.length + answer.buyers.length;
    kept += context.alternatives.length + context.money.length + context.buyers.length;
  }
  const share = (count: number, total: number) => (total === 0 ? 0 : count / total);
  const metrics = {
    alternatives: share(recall, recallCases),
    money: share(money, results.length),
    grounded: proposed === 0 ? 1 : kept / proposed,
    answered: share(answered, results.length),
  };
  return {
    passed:
      metrics.alternatives >= 0.8 &&
      metrics.money >= 0.85 &&
      metrics.grounded >= 0.9 &&
      metrics.answered >= 0.9,
    metrics,
  };
}

export const marketContextTask: AiTask<
  MarketContextInput,
  MarketContextOutput,
  MarketContextExpected
> = {
  name: 'market-context',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You read forum posts about a business opportunity and list what they say about its market.',
    'Use only the posts. Never add tools, companies, prices or facts the posts do not mention.',
    'Every item needs a quote copied exactly from one post and that post number (E1 = 1).',
    '- alternatives: what people use or do now instead: a product, a paid service, manual work',
    '  (spreadsheets, paper, calls, hand work) or something built in house. name: short, as in',
    '  the post.',
    '- money: each sum of money people say they pay or lose because of the problem. The quote',
    '  must contain the amount as written. period: how often, if the post says it.',
    '- buyers: who pays or decides (a role, e.g. "agency owner"), only if a post shows it.',
    'Empty lists are fine when the posts say nothing.',
  ].join('\n'),
  input,
  output,
  render: ({ opportunity, excerpts }) =>
    [
      `Opportunity: ${opportunity.title}`,
      `Summary: ${opportunity.summary}`,
      `Customer: ${opportunity.icp}`,
      '',
      'Posts:',
      ...excerpts.map((excerpt, index) => `E${String(index + 1)}. """${excerpt}"""`),
    ].join('\n'),
  maxOutputTokens: 1_536,
  // Worst case: ~15 000 input tokens (twelve full excerpts) and 1 536 output on the dearest
  // bulk model.
  maxCostMicroUsd: 20_000,
  // A few opportunities every six hours; ~$0.002 a call on the cheapest model.
  dailyShare: 0.07,
  evalCases: cases,
  score: scoreMarketContext,
};
