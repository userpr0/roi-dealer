import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import { SIGNAL_STRENGTHS } from '@roi-dealer/domain';

/*
 * PHASE 06: does one Evidence excerpt show a pain, and which one. The model proposes; code keeps
 * the signal only when its quote is really in the text (§2.3, §2.5).
 */

const input = z.strictObject({ text: z.string().min(1).max(1_200) });
// Every field is required (strict structured output); limits are checked in code.
const output = z.strictObject({
  pain: z.boolean(),
  statement: z.string(),
  audience: z.string(),
  outcome: z.string(),
  strength: z.enum(SIGNAL_STRENGTHS),
  quote: z.string(),
});

export type ExtractSignalInput = z.infer<typeof input>;
export type ExtractSignalOutput = z.infer<typeof output>;
/** What a correct answer must say; the text is kept to check the quote. */
export interface ExtractSignalExpected {
  readonly pain: boolean;
  readonly text: string;
}

const PAINS = [
  "Ask HN: How do you chase unpaid invoices? I'm a freelance designer and half my clients pay 60+ days late. I spend every Friday sending reminder emails instead of working.",
  "We're a 5-person agency and reconciling Stripe payouts with QuickBooks takes our accountant 6 hours a week. Every month something doesn't match and we can't find why.",
  "Ask HN: Anyone else drowning in SOC 2 paperwork? Our startup lost two enterprise deals this quarter because we couldn't answer the security questionnaire in time.",
  'I run a small dental clinic. Patients no-show about 15% of appointments and the reminder SMS tool we use costs $300/month and still misses half of them.',
  'Ask HN: How do you manage on-call for a 3-person team? We get paged at night for alerts that turn out to be noise and everyone is burning out.',
  'Our support inbox gets 400 emails a day and most are the same 10 questions about shipping. Hiring another agent costs more than we make on those orders.',
  "Ask HN: Tools for tracking inventory across Shopify and Amazon? We oversold 40 orders last month because stock didn't sync and had to refund them.",
  'As a solo developer, I lose hours every week rewriting the same onboarding emails for each client project. There has to be a better way.',
  'Ask HN: How do small landlords handle maintenance requests? Tenants text me photos at all hours and I keep losing track of which repairs were done.',
  'Every time a contractor leaves, we discover they had admin access to a dozen SaaS tools and nobody knows which ones. Offboarding is a mess.',
  'Ask HN: Is it just me or is hiring for a 10-person startup impossible? We spent $8k on job boards and got 300 irrelevant applications.',
  "Our restaurant throws away about $2,000 of food a month because we can't predict how many customers will come on weekdays.",
];

const NOT_PAINS = [
  'Show HN: I built a static site generator in Rust',
  'Ask HN: What are you reading this summer?',
  'Ask HN: Who is hiring? (October 2026)',
  "Ask HN: What's your favorite programming font and why?",
  'I just launched my side project after two years of nights and weekends. Thanks to everyone who gave feedback here!',
  'Ask HN: Is it worth learning Haskell in 2026 for fun?',
  'Interesting article about the history of the Unix shell, highly recommend it.',
  'Ask HN: What did you work on this weekend?',
  'Tell HN: Our open-source project just hit 10,000 stars on GitHub.',
  'Ask HN: Recommend a good mechanical keyboard for programming?',
  'Ask HN: Which city has the best tech meetups in Europe?',
  'We switched our blog from WordPress to a static site and page loads are now under 100 ms. Happy with the result.',
];

const cases = [
  ...PAINS.map((text) => ({ input: { text }, expected: { pain: true, text } })),
  ...NOT_PAINS.map((text) => ({ input: { text }, expected: { pain: false, text } })),
];

const MIN_QUOTE = 10;
const MAX_QUOTE = 300;
const MIN_STATEMENT = 10;
const MAX_STATEMENT = 300;
const MAX_FIELD = 200;
const NOT_STATED = 'Not stated in the evidence';

function normalized(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/** The quote without surrounding quote marks or an ellipsis, as the model may add them. */
function bareQuote(quote: string): string {
  return quote
    .trim()
    .replace(/^["'“‘«]+|["'”’»]+$/g, '')
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, '')
    .trim();
}

/** Whether the quote is really in the text: case and spacing aside, at least 10 characters. */
export function quoteInText(text: string, quote: string): boolean {
  const bare = bareQuote(quote);
  return bare.length >= MIN_QUOTE && normalized(text).includes(normalized(bare));
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** A pain the code accepted from the model's answer. */
export interface SignalDraft {
  readonly statement: string;
  readonly audience: string;
  readonly outcome: string;
  readonly strength: ExtractSignalOutput['strength'];
  readonly quote: string;
}

/**
 * Checks the model's answer against the text (§2.5): `undefined` when it shows no pain;
 * `'rejected'` when the quote is not in the text or the statement is unusable.
 */
export function toSignalDraft(
  text: string,
  answer: ExtractSignalOutput,
): SignalDraft | 'rejected' | undefined {
  if (!answer.pain) return undefined;
  const statement = answer.statement.trim().replace(/\s+/g, ' ');
  const quote = bareQuote(answer.quote);
  if (
    statement.length < MIN_STATEMENT ||
    statement.length > MAX_STATEMENT ||
    quote.length > MAX_QUOTE ||
    !quoteInText(text, quote)
  ) {
    return 'rejected';
  }
  return {
    statement,
    audience: clip(answer.audience, MAX_FIELD) || NOT_STATED,
    outcome: clip(answer.outcome, MAX_FIELD) || NOT_STATED,
    strength: answer.strength,
    quote,
  };
}

/** Detection precision and recall over the golden set, and how often the quote checks out. */
export function scoreExtractSignal(
  results: readonly {
    readonly expected: ExtractSignalExpected;
    readonly output: ExtractSignalOutput | undefined;
  }[],
): EvalScore {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let validQuotes = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer !== undefined) answered += 1;
    const found = answer?.pain === true;
    if (found && expected.pain) {
      truePositives += 1;
      const draft = toSignalDraft(expected.text, answer);
      if (draft !== undefined && draft !== 'rejected') validQuotes += 1;
    } else if (found) {
      falsePositives += 1;
    } else if (expected.pain) {
      falseNegatives += 1;
    }
  }
  const ratio = (part: number, whole: number) => (whole === 0 ? 1 : part / whole);
  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  const quotes = ratio(validQuotes, truePositives);
  const answeredShare = results.length === 0 ? 0 : answered / results.length;
  return {
    passed: precision >= 0.85 && recall >= 0.85 && quotes >= 0.9 && answeredShare >= 0.9,
    metrics: { precision, recall, quotes, answered: answeredShare },
  };
}

export const extractSignalTask: AiTask<
  ExtractSignalInput,
  ExtractSignalOutput,
  ExtractSignalExpected
> = {
  name: 'extract-signal',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You read one short public post from an online forum and decide whether it shows a pain:',
    'a real, recurring difficulty, cost, risk or frustration that a person or a business has',
    'and might pay to solve, described by someone who experiences it.',
    'Not a pain: announcements, launches (Show HN), job posts, general questions or',
    'recommendations without a stated difficulty, opinions about news.',
    'If there is a pain, fill in:',
    '- statement: one sentence in English, "<who> struggle(s) to <do what> because <why>"',
    '  when the post allows; no names of people.',
    '- audience: who has this problem (role or type of business), a few words.',
    '- outcome: the result they want, a few words.',
    '- strength: strong — costly or urgent (money, time, customers lost); moderate — a clear',
    '  problem without a stated cost; weak — mild or vague.',
    '- quote: words copied exactly from the post (up to 200 characters) that show the problem.',
    'If there is no pain, set pain to false, every text field to an empty string and strength',
    'to weak. Never add facts that are not in the post.',
  ].join('\n'),
  input,
  output,
  render: ({ text }) => `Post:\n"""\n${text}\n"""`,
  maxOutputTokens: 1_024,
  // Worst case: ~2 400 input and 1 024 output tokens on the dearest bulk model.
  maxCostMicroUsd: 10_000,
  // ~$0.0002 a post on the cheapest model; up to 720 posts a day fit into 15% of $1.6.
  dailyShare: 0.15,
  evalCases: cases,
  score: scoreExtractSignal,
};
