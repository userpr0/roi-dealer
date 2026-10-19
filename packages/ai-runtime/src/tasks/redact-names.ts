import { z } from 'zod';
import type { AiRuntime, TaskContext } from '../runtime.js';
import type { AiTask, EvalCase, EvalScore } from '../task.js';

/*
 * First AI task (PHASE 09): find the names of people in an evidence excerpt. The model only
 * proposes the list; code replaces the names (§2.3). Closes the residual privacy risk of PHASE 05.
 */

const input = z.strictObject({ text: z.string().min(1).max(5_000) });
// Kept minimal: structured output modes of both providers accept it as is; limits apply in code.
const output = z.strictObject({ names: z.array(z.string()) });

export type RedactNamesInput = z.infer<typeof input>;
export type RedactNamesOutput = z.infer<typeof output>;

const MAX_NAME_LENGTH = 80;
const MAX_NAMES = 50;

const cases: readonly EvalCase<RedactNamesInput, readonly string[]>[] = [
  ['My cofounder Sarah Chen and I built a CRM for dentists.', ['Sarah Chen']],
  ['We use Notion and Linear for planning; Stripe handles billing.', []],
  ['Ask HN: How did you get your first 10 customers?', []],
  ['John told me that QuickBooks crashes every time we export.', ['John']],
  ['I emailed Maria Gonzalez at Acme Corp twice, no reply.', ['Maria Gonzalez']],
  ['Paris is expensive for a small agency like ours.', []],
  ['Thanks to Priya Patel, our clinic finally switched to online booking.', ['Priya Patel']],
  ['Our accountant, Mike, spends 6 hours a week reconciling invoices.', ['Mike']],
  ['Apple and Google both rejected the app twice.', []],
  ['Elon Musk tweets aside, the API pricing is the real issue.', ['Elon Musk']],
  ['My manager (Tom Becker) insists on spreadsheets.', ['Tom Becker']],
  ['The [handle] team shipped a fix yesterday.', []],
  ['Jordan and Casey run the support desk with me.', ['Jordan', 'Casey']],
  ['We migrated from Salesforce to HubSpot last spring.', []],
  ['Anna Kowalska, our designer, quit because Figma licenses got too pricey.', ['Anna Kowalska']],
  ['Is anyone else frustrated with Shopify payouts taking a week?', []],
  ['Ben from accounting and Lisa Wong from sales both hate the new ERP.', ['Ben', 'Lisa Wong']],
  ['Show HN: I built a tool to track freelance invoices', []],
  [
    'After talking to Dave Smith and his wife Emma, I realized they pay $200 a month for this.',
    ['Dave Smith', 'Emma'],
  ],
  ['Microsoft Teams keeps dropping calls with clients in Texas.', []],
  ['Our CTO, Rahul Mehta, wrote the first version over a weekend.', ['Rahul Mehta']],
  ['The Linear app is great, but Jira is what my clients use.', []],
  ["Kevin O'Brien suggested we charge per seat.", ["Kevin O'Brien"]],
  ['Hiring is hard; we interviewed 40 people for one role.', []],
].map(([text, names]) => ({ input: { text: text as string }, expected: names as string[] }));

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A proposed name matches an expected one when one contains the other (`Dr. Patel` ~ `Patel`). */
function matches(proposed: string, expected: string): boolean {
  const a = normalize(proposed);
  const b = normalize(expected);
  return a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a)));
}

/** Precision and recall of the proposed names over the golden set. */
export function scoreRedactNames(
  results: readonly {
    readonly expected: readonly string[];
    readonly output: RedactNamesOutput | undefined;
  }[],
): EvalScore {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    const proposed = answer?.names ?? [];
    if (answer !== undefined) answered += 1;
    truePositives += expected.filter((name) => proposed.some((p) => matches(p, name))).length;
    falseNegatives += expected.filter((name) => !proposed.some((p) => matches(p, name))).length;
    falsePositives += proposed.filter((p) => !expected.some((name) => matches(p, name))).length;
  }
  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const answeredShare = results.length === 0 ? 0 : answered / results.length;
  return {
    passed: recall >= 0.9 && precision >= 0.8 && answeredShare >= 0.9,
    metrics: { precision, recall, answered: answeredShare },
  };
}

export const redactNamesTask: AiTask<RedactNamesInput, RedactNamesOutput, readonly string[]> = {
  name: 'redact-names',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You find the names of people in a short text from a public forum.',
    'Return every name of a person (first name, last name or full name) exactly as written in the text.',
    'Do not return names of companies, products, apps, projects, places or teams.',
    'Ignore placeholders in square brackets such as [handle] or [email].',
    'If there are no names of people, return an empty list.',
  ].join('\n'),
  input,
  output,
  render: ({ text }) => `Text:\n"""\n${text}\n"""`,
  maxOutputTokens: 2_048,
  maxCostMicroUsd: 15_000,
  // ~$0.0001 a call on the cheapest model: 10% of a $1.6 day is over a thousand excerpts.
  dailyShare: 0.1,
  evalCases: cases,
  score: scoreRedactNames,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the proposed names with `[name]`. Names that do not occur in the text (invented by
 * the model), too short or too long are ignored; longer names are replaced first.
 */
export function applyNameRedaction(
  text: string,
  names: readonly string[],
): { text: string; replaced: number } {
  const usable = [...new Set(names.map((name) => name.trim()))]
    .filter((name) => name.length >= 2 && name.length <= MAX_NAME_LENGTH && text.includes(name))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_NAMES);
  let result = text;
  let replaced = 0;
  for (const name of usable) {
    result = result.replace(new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, 'g'), () => {
      replaced += 1;
      return '[name]';
    });
  }
  return { text: result, replaced };
}

/** Asks the model for the names in `text` and replaces them; throws `AiTaskError` when AI is unavailable. */
export async function redactNames(
  runtime: AiRuntime,
  text: string,
  context: TaskContext,
): Promise<{ text: string; replaced: number }> {
  const { names } = await runtime.runTask(redactNamesTask, { text }, context);
  return applyNameRedaction(text, names);
}
