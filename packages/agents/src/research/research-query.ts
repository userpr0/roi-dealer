import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';

/*
 * PHASE 10: the words people would use to describe a pain, to search a source for more posts
 * about it. The model proposes queries; code keeps only plain words (letters, digits, spaces),
 * so nothing but a short query reaches the source.
 */

const input = z.strictObject({
  title: z.string().min(1).max(200),
  audience: z.string().min(1).max(1_000),
  desiredOutcome: z.string().min(1).max(1_000),
});
const output = z.strictObject({ queries: z.array(z.string()) });

export type ResearchQueryInput = z.infer<typeof input>;
export type ResearchQueryOutput = z.infer<typeof output>;
/** Any one of these words (or word starts) makes a query relevant to the pain. */
export interface ResearchQueryExpected {
  readonly keys: readonly string[];
}

const MIN_WORDS = 2;
const MAX_WORDS = 5;
export const MAX_QUERY_CHARS = 60;

/** A query as code accepts it: lowercase plain words, 2–5 of them, at most 60 characters. */
export function cleanQuery(query: string): string | undefined {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
  const text = words.join(' ');
  if (words.length < MIN_WORDS || words.length > MAX_WORDS || text.length > MAX_QUERY_CHARS) {
    return undefined;
  }
  return text;
}

/** The first proposed query that passes `cleanQuery`, if any. */
export function toSearchQuery(answer: ResearchQueryOutput): string | undefined {
  for (const query of answer.queries.slice(0, 3)) {
    const clean = cleanQuery(query);
    if (clean !== undefined) return clean;
  }
  return undefined;
}

/** Whether a query has a word starting with `key` (a key of several words: that phrase). */
export function mentions(query: string, key: string): boolean {
  return ` ${query}`.includes(` ${key}`);
}

type Case = readonly [title: string, audience: string, outcome: string, keys: readonly string[]];

const golden: readonly Case[] = [
  [
    'Small agencies struggle to reconcile Stripe payouts with accounting',
    'Small agencies',
    'Books match payouts automatically',
    ['stripe', 'reconcil', 'payout', 'bookkeep', 'quickbooks'],
  ],
  [
    'Freelancers spend hours chasing late invoice payments',
    'Freelancers',
    'Clients pay invoices on time',
    ['invoice', 'late pay', 'payment', 'chas'],
  ],
  [
    'Small engineering teams burn out from noisy on-call alerts',
    'Small engineering teams',
    'Only real incidents wake people up',
    ['alert', 'pager', 'paging', 'oncall', 'on call', 'incident'],
  ],
  [
    'Independent landlords struggle to collect rent on time',
    'Independent landlords',
    'Rent arrives on time every month',
    ['rent', 'tenant', 'landlord'],
  ],
  [
    'Working parents cannot find reliable after-school childcare',
    'Working parents',
    'Kids are looked after every afternoon',
    ['childcare', 'child care', 'babysit', 'nanny', 'after school', 'daycare'],
  ],
  [
    'Small online shops oversell because inventory is out of sync across channels',
    'Small online shops',
    'Stock is the same on every channel',
    ['inventory', 'stock', 'sync', 'oversell'],
  ],
  [
    'Podcasters spend hours editing audio by hand',
    'Independent podcasters',
    'Episodes are edited in minutes',
    ['podcast', 'audio', 'edit'],
  ],
  [
    'Remote teams lose track of decisions made in chat',
    'Remote teams',
    'Every decision is easy to find later',
    ['decision', 'slack', 'chat', 'meeting', 'documentation', 'knowledge'],
  ],
  [
    'Small clinics lose revenue to patient no-shows',
    'Small clinics',
    'Patients come to their appointments',
    ['no show', 'noshow', 'appointment', 'patient', 'clinic'],
  ],
  [
    'Small online sellers cannot keep up with sales tax rules across states',
    'Small online sellers',
    'Sales tax is filed correctly without effort',
    ['sales tax', 'tax'],
  ],
  [
    'SaaS founders lose customers to failed card payments',
    'SaaS founders',
    'Failed payments are recovered',
    ['churn', 'failed payment', 'dunning', 'card', 'payment', 'involuntary'],
  ],
  [
    'Homeowners struggle to find trustworthy contractors',
    'Homeowners',
    'Repairs done by reliable people',
    ['contractor', 'renovation', 'plumber', 'handyman', 'home repair', 'remodel'],
  ],
  [
    'Teachers spend their evenings grading essays',
    'High school teachers',
    'Essays graded fairly in less time',
    ['grading', 'grade', 'essay', 'teacher'],
  ],
  [
    'Small e-commerce stores drown in repetitive customer support emails',
    'Small e-commerce stores',
    'Common questions answered without staff',
    ['support', 'customer service', 'email', 'ticket', 'helpdesk'],
  ],
  [
    'Developers waste hours on flaky tests in CI',
    'Software teams',
    'Builds fail only for real bugs',
    ['flaky', 'test', 'ci'],
  ],
  [
    'Freelance designers wait weeks for clients to approve their work',
    'Freelance designers',
    'Clients give feedback on time',
    ['client', 'feedback', 'approval', 'revision', 'design'],
  ],
  [
    'Small nonprofits struggle to keep track of donations and donors',
    'Small nonprofits',
    'Every donation and donor in one place',
    ['donation', 'donor', 'nonprofit', 'non profit', 'fundrais', 'crm'],
  ],
  [
    'People keep paying for subscriptions they forgot to cancel',
    'Consumers with many subscriptions',
    'No money lost on unused subscriptions',
    ['subscription', 'cancel', 'recurring'],
  ],
  [
    'Small law firms lose billable hours because time tracking is manual',
    'Small law firms',
    'Every billable hour is captured',
    ['time track', 'billable', 'billing', 'timesheet', 'law'],
  ],
  [
    'Restaurants throw away food because supplies are ordered by guesswork',
    'Independent restaurants',
    'Orders match what is actually used',
    ['restaurant', 'food waste', 'waste', 'inventory', 'ordering', 'order'],
  ],
  [
    'Small manufacturers lose track of which supplier parts are late',
    'Small manufacturers',
    'Late parts are known before they block production',
    ['supplier', 'supply chain', 'parts', 'procurement', 'purchase order', 'late'],
  ],
];

const cases = golden.map(([title, audience, desiredOutcome, keys]) => ({
  input: { title, audience, desiredOutcome },
  expected: { keys },
}));

/** Valid queries and queries with a word of the pain — over the golden set. */
export function scoreResearchQuery(
  results: readonly {
    readonly expected: ResearchQueryExpected;
    readonly output: ResearchQueryOutput | undefined;
  }[],
): EvalScore {
  let valid = 0;
  let relevant = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    const query = toSearchQuery(answer);
    if (query === undefined) continue;
    valid += 1;
    if (expected.keys.some((key) => mentions(query, key))) relevant += 1;
  }
  const share = (count: number) => (results.length === 0 ? 0 : count / results.length);
  const metrics = { valid: share(valid), relevant: share(relevant), answered: share(answered) };
  return {
    passed: metrics.valid >= 0.9 && metrics.relevant >= 0.85 && metrics.answered >= 0.9,
    metrics,
  };
}

export const researchQueryTask: AiTask<
  ResearchQueryInput,
  ResearchQueryOutput,
  ResearchQueryExpected
> = {
  name: 'research-query',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You help find more forum posts about a problem people have.',
    'Given the problem, write one or two search queries for a forum search engine.',
    '- Each query: 2 to 4 plain English words that people who have this problem would write',
    '  in a post, e.g. "stripe payout reconciliation" or "late invoice payments".',
    '- Use the most specific words: the tool, the task or the thing that goes wrong.',
    '- No quotes, operators, punctuation, names of people or company names you invented.',
    '- The most promising query first.',
  ].join('\n'),
  input,
  output,
  render: ({ title, audience, desiredOutcome }) =>
    [`Problem: ${title}`, `Who has it: ${audience}`, `What they want: ${desiredOutcome}`].join(
      '\n',
    ),
  maxOutputTokens: 256,
  // Worst case: ~3 000 input tokens (full fields) and 256 output on the dearest bulk model.
  maxCostMicroUsd: 5_000,
  // A few pains every six hours; a fraction of a cent a call.
  dailyShare: 0.03,
  evalCases: cases,
  score: scoreResearchQuery,
};
