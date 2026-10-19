import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import {
  EVIDENCE_REQUIRED,
  JUDGE_CRITERIA,
  MAX_JUDGE_SCORE,
  MIN_JUDGE_SCORE,
  UNSUPPORTED_MAX_SCORE,
  type JudgeCriterion,
} from '@roi-dealer/domain';

/*
 * PHASE 11: one judge, one criterion, one call. The model scores the opportunity 1–5 on the
 * criterion's scale and cites the excerpts it relies on; code checks the answer, keeps only
 * existing citations and caps the score of an evidence-bound criterion without any (§2.5).
 */

export const MAX_JUDGE_EXCERPTS = 6;
export const JUDGE_EXCERPT_LENGTH = 600;
const MIN_RATIONALE = 20;
const MAX_RATIONALE = 600;
const MAX_CONCERNS = 3;
const MAX_CONCERN = 200;

/** The scale of each criterion, as the judge sees it. Higher is always better for us. */
export const CRITERION_SCALES: Readonly<Record<JudgeCriterion, string>> = {
  market: [
    'Market: is there a real market we can reach in the US, UK, Canada or Australia?',
    '5 = many people clearly have this problem, buyers are easy to find and reach, and they',
    'already pay for alternatives. 3 = a real but narrow or hard-to-reach group. 1 = one person',
    'or a tiny niche, or no way to reach the buyers.',
  ].join(' '),
  pain_value: [
    'Pain and value: how much does the problem hurt and what is solving it worth?',
    '5 = frequent, costs money, time or customers now, people actively look for a fix.',
    '3 = a real annoyance with a moderate cost. 1 = a mild wish or a one-off curiosity.',
  ].join(' '),
  economics: [
    'Economics: can this make money at a small cost? 5 = people already pay comparable amounts,',
    'the price would cover the cost to serve (AI, APIs, people) many times, and revenue can',
    'recur. 3 = willingness to pay is unclear or margins are thin. 1 = nobody pays for this, or',
    'serving one customer costs more than they would pay.',
  ].join(' '),
  buildability: [
    'Buildability: can one owner with AI coding tools ship a minimum sellable product in a few',
    'weeks? 5 = standard web or bot software on public APIs, no special licences or hardware.',
    '3 = needs a hard integration, a data partnership or ongoing manual work. 1 = needs',
    'hardware, regulated licences, data we cannot get, or a large team.',
  ].join(' '),
  risk: [
    'Risk (5 = low risk): 5 = no regulated advice, no sensitive personal data, no dependence on',
    "one platform's goodwill. 3 = some personal data or platform dependence that can be",
    'managed. 1 = regulated (medical, legal or financial advice, gambling), sensitive data at',
    'scale, or likely to break platform terms or laws.',
  ].join(' '),
  reuse: [
    'Reuse: will what we build or learn help other opportunities? 5 = the product, data or',
    'audience is reusable across many similar opportunities, or the similar past cases show a',
    'pattern we can reuse. 3 = some parts are reusable. 1 = a one-off with nothing reusable.',
  ].join(' '),
};

const input = z.strictObject({
  criterion: z.enum(JUDGE_CRITERIA),
  opportunity: z.strictObject({
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1_000),
    icp: z.string().min(1).max(500),
    problem: z.string().min(1).max(500),
    change: z.string().min(1).max(500),
    measurableResult: z.string().min(1).max(300),
    businessModel: z.string().min(1).max(300),
  }),
  /** Numbers from the database: signals, sources, parts of the PHASE 07 score. */
  facts: z.string().max(500),
  excerpts: z.array(z.string().min(1).max(JUDGE_EXCERPT_LENGTH)).min(1).max(MAX_JUDGE_EXCERPTS),
  /** The market context of PHASE 10, or empty. */
  market: z.string().max(1_000),
  similarCases: z.array(z.string().min(1).max(300)).max(3),
});
// Every field is required (strict structured output); limits are checked in code.
const output = z.strictObject({
  score: z.int(),
  rationale: z.string(),
  evidence: z.array(z.int()),
  concerns: z.array(z.string()),
});

export type JudgeInput = z.infer<typeof input>;
export type JudgeOutput = z.infer<typeof output>;
export interface JudgeExpected {
  readonly criterion: JudgeCriterion;
  readonly min: number;
  readonly max: number;
  readonly excerpts: number;
}

/** A judgement the code accepted; `evidence` holds 0-based excerpt indexes. */
export interface CheckedJudgement {
  readonly score: number;
  readonly supported: boolean;
  readonly rationale: string;
  readonly concerns: readonly string[];
  readonly evidence: readonly number[];
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Checks a judge's answer: an integer score 1–5 and a rationale of at least 20 characters,
 * otherwise `rejected`; only citations of existing excerpts are kept. A criterion that must
 * rest on evidence and cites none scores at most 2.
 */
export function toJudgement(
  criterion: JudgeCriterion,
  excerpts: number,
  answer: JudgeOutput,
): CheckedJudgement | 'rejected' {
  const rationale = clip(answer.rationale, MAX_RATIONALE);
  if (
    !Number.isInteger(answer.score) ||
    answer.score < MIN_JUDGE_SCORE ||
    answer.score > MAX_JUDGE_SCORE ||
    rationale.length < MIN_RATIONALE
  ) {
    return 'rejected';
  }
  const evidence = [
    ...new Set(
      answer.evidence.filter(
        (number) => Number.isInteger(number) && number >= 1 && number <= excerpts,
      ),
    ),
  ]
    .sort((a, b) => a - b)
    .map((number) => number - 1);
  const required = EVIDENCE_REQUIRED.includes(criterion);
  const supported = evidence.length > 0;
  return {
    score: required && !supported ? Math.min(answer.score, UNSUPPORTED_MAX_SCORE) : answer.score,
    supported,
    rationale,
    concerns: answer.concerns
      .map((concern) => clip(concern, MAX_CONCERN))
      .filter((concern) => concern !== '')
      .slice(0, MAX_CONCERNS),
    evidence,
  };
}

interface Base {
  readonly opportunity: JudgeInput['opportunity'];
  readonly facts: string;
  readonly excerpts: readonly string[];
  readonly market: string;
  readonly similarCases?: readonly string[];
}

const opportunity = (
  title: string,
  icp: string,
  problem: string,
  change: string,
  measurableResult: string,
  businessModel: string,
): JudgeInput['opportunity'] => ({
  title,
  summary: `${problem}. ${change}.`,
  icp,
  problem,
  change,
  measurableResult,
  businessModel,
});

/** Eight opportunities of the golden set, from clearly strong to clearly weak. */
const BASES: Readonly<Record<string, Base>> = {
  payouts: {
    opportunity: opportunity(
      'Automatic payout reconciliation for small agencies',
      'Agencies with 2–20 people that take payments through Stripe',
      'Matching Stripe payouts with the books takes hours every week',
      'Payouts are matched with QuickBooks automatically every day',
      'Six hours a week saved per agency',
      'subscription — $49 a month',
    ),
    facts:
      '3 signals from 1 source; PHASE 07 score 70/100 (frequency 15, severity 16, willingness 20).',
    excerpts: [
      'Reconciling Stripe payouts with QuickBooks takes our accountant 6 hours a week.',
      'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
      "Every agency owner I know exports payouts to a spreadsheet; it's the most hated task of the month.",
    ],
    market:
      'Alternatives in use: spreadsheet (manual); bookkeeper (service). Money mentioned: $400 a month.',
  },
  invoices: {
    opportunity: opportunity(
      'Invoices that get paid without chasing',
      'Freelancers and two-person studios in the US',
      'Clients pay late and freelancers spend hours sending reminders',
      'Polite reminders and follow-ups run on their own until the invoice is paid',
      'A day a month back and fewer unpaid invoices',
      'subscription — $12 a month',
    ),
    facts:
      '4 signals from 1 source; PHASE 07 score 64/100 (frequency 20, severity 12, willingness 10).',
    excerpts: [
      'I spend every Friday chasing invoices instead of doing paid work.',
      'I lose about $2,000 a year to clients who never pay.',
      'FreshBooks reminders get ignored, clients only answer when I call them.',
    ],
    market: 'Alternatives in use: FreshBooks (product). Money mentioned: $2,000 a year.',
    similarCases: [
      'Rent that arrives on time for small landlords: automatic reminders and follow-ups',
      'Fewer patient no-shows for small clinics: reminders before each appointment',
    ],
  },
  skin: {
    opportunity: opportunity(
      'Instant AI diagnosis of skin conditions from a photo',
      'Adults worried about a rash or a mole',
      'People wait months to see a dermatologist',
      'An app tells from a photo whether a skin problem is dangerous',
      'An answer in minutes instead of months',
      'subscription — $9 a month',
    ),
    facts: '2 signals from 1 source; PHASE 07 score 58/100.',
    excerpts: [
      'I waited 3 months for a dermatologist appointment for a rash.',
      "I'd pay to know quickly if a mole is something to worry about.",
    ],
    market: '',
  },
  plants: {
    opportunity: opportunity(
      'Reminders to water houseplants',
      'People with a few houseplants',
      'People forget which plant needs water',
      'A reminder says which plant to water and when',
      'Fewer dead plants',
      'free_limit — free with a paid plan for many plants',
    ),
    facts: '2 signals from 1 source; PHASE 07 score 55/100 (willingness 0).',
    excerpts: [
      'I always forget which plant needs water, it would be nice to have a reminder.',
      'My basil died again, oh well.',
    ],
    market: '',
  },
  cattle: {
    opportunity: opportunity(
      'Early sickness alerts for small cattle ranches',
      'Ranchers with 50–300 head of cattle',
      'Sick calves are noticed too late and die',
      'A collar sensor warns when an animal shows the first signs of sickness',
      'Fewer calves lost every spring',
      'subscription — $3 per head a month plus the collar',
    ),
    facts: '2 signals from 1 source; PHASE 07 score 60/100.',
    excerpts: [
      'We lose a few calves every spring because we notice sickness too late.',
      'The commercial collars cost $80 per head plus a subscription, too much for a small ranch.',
    ],
    market: 'Alternatives in use: commercial collars (product). Money mentioned: $80.',
  },
  press: {
    opportunity: opportunity(
      'Maintenance log for a 1994 Heidelberg press',
      'Print shops that still run one specific 1994 Heidelberg press',
      'Maintenance of an old press is logged on paper',
      'A digital log with reminders for that press model',
      'No missed maintenance',
      'one_time — $49',
    ),
    facts: '1 signal from 1 source; PHASE 07 score 56/100.',
    excerpts: ['Our shop runs a single 1994 Heidelberg press; I log its maintenance on paper.'],
    market: 'Alternatives in use: paper (manual).',
  },
  tickets: {
    opportunity: opportunity(
      'Bots that buy concert tickets the moment they go on sale',
      'Fans who miss popular concerts',
      'Tickets sell out in seconds to resellers',
      'Our bots buy tickets for the user before the resellers do',
      'Tickets to sold-out shows at face value',
      'outcome_based — 10% of the ticket price',
    ),
    facts: '2 signals from 1 source; PHASE 07 score 57/100.',
    excerpts: [
      'Tickets sell out in seconds and bots buy everything.',
      'I would pay extra just to get a ticket at face value.',
    ],
    market: '',
  },
  flaky: {
    opportunity: opportunity(
      'Builds that fail only for real bugs',
      'Software teams of 5–50 engineers on GitHub Actions',
      'Flaky tests make teams rerun CI jobs and ignore failures',
      'Flaky tests are detected, quarantined and reported automatically',
      'Half the CI reruns and minutes',
      'subscription — $99 a month per team',
    ),
    facts: '3 signals from 1 source; PHASE 07 score 66/100 (willingness 20).',
    excerpts: [
      'We just retry the CI job up to three times and hope.',
      'We pay $500 a month for extra CI minutes, mostly reruns.',
      'Nobody trusts a red build anymore because of flaky tests.',
    ],
    market: 'Alternatives in use: retries (manual). Money mentioned: $500 a month.',
  },
};

type Case = readonly [
  criterion: JudgeCriterion,
  base: keyof typeof BASES,
  min: number,
  max: number,
];

const golden: readonly Case[] = [
  ['market', 'payouts', 4, 5],
  ['market', 'invoices', 4, 5],
  ['market', 'press', 1, 2],
  ['market', 'plants', 1, 3],
  ['pain_value', 'payouts', 4, 5],
  ['pain_value', 'plants', 1, 2],
  ['pain_value', 'invoices', 3, 5],
  ['pain_value', 'cattle', 3, 5],
  ['economics', 'payouts', 4, 5],
  ['economics', 'plants', 1, 2],
  ['economics', 'flaky', 3, 5],
  ['economics', 'press', 1, 2],
  ['buildability', 'payouts', 4, 5],
  ['buildability', 'skin', 1, 2],
  ['buildability', 'cattle', 1, 2],
  ['buildability', 'flaky', 4, 5],
  ['risk', 'skin', 1, 2],
  ['risk', 'tickets', 1, 2],
  ['risk', 'flaky', 4, 5],
  ['risk', 'payouts', 3, 5],
  ['reuse', 'invoices', 4, 5],
  ['reuse', 'press', 1, 2],
  ['reuse', 'payouts', 3, 5],
  ['reuse', 'plants', 1, 3],
];

const cases = golden.map(([criterion, key, min, max]) => {
  const base = BASES[key] as Base;
  return {
    input: {
      criterion,
      opportunity: base.opportunity,
      facts: base.facts,
      excerpts: [...base.excerpts],
      market: base.market,
      similarCases: [...(base.similarCases ?? [])],
    },
    expected: { criterion, min, max, excerpts: base.excerpts.length },
  };
});

/** Scores in the expected range, citations where required, valid answers — over the set. */
export function scoreJudge(
  results: readonly {
    readonly expected: JudgeExpected;
    readonly output: JudgeOutput | undefined;
  }[],
): EvalScore {
  let inRange = 0;
  let cited = 0;
  let citing = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    const required = EVIDENCE_REQUIRED.includes(expected.criterion);
    if (required) citing += 1;
    if (answer === undefined) continue;
    const judgement = toJudgement(expected.criterion, expected.excerpts, answer);
    if (judgement === 'rejected') continue;
    answered += 1;
    if (judgement.score >= expected.min && judgement.score <= expected.max) inRange += 1;
    if (required && judgement.supported) cited += 1;
  }
  const share = (count: number, total: number) => (total === 0 ? 0 : count / total);
  const metrics = {
    in_range: share(inRange, results.length),
    cited: share(cited, citing),
    answered: share(answered, results.length),
  };
  return {
    passed: metrics.in_range >= 0.75 && metrics.cited >= 0.9 && metrics.answered >= 0.9,
    metrics,
  };
}

export const judgeOpportunityTask: AiTask<JudgeInput, JudgeOutput, JudgeExpected> = {
  name: 'judge-opportunity',
  version: 1,
  tier: 'strong',
  instructions: [
    'You are one judge on a panel that assesses business opportunities for a small company',
    'that builds software products with AI and tests them cheaply with real customers.',
    'You judge one criterion only, on its 1–5 scale. Be strict and calibrated: most',
    'opportunities are average; give 5 or 1 only when the material clearly shows it.',
    'Use only the material given: the opportunity, the facts, the forum excerpts (E1, E2, …),',
    'the market context and similar past cases. Do not invent numbers, customers or competitors.',
    '- score: an integer 1–5 on the criterion scale.',
    '- rationale: two to four sentences: why this score, with the facts that decide it.',
    '- evidence: the numbers of the excerpts your rationale relies on (E2 = 2); empty if none.',
    '- concerns: up to three short risks or unknowns the owner should check.',
  ].join('\n'),
  input,
  output,
  render: ({ criterion, opportunity: item, facts, excerpts, market, similarCases }) =>
    [
      `Criterion: ${CRITERION_SCALES[criterion]}`,
      '',
      `Opportunity: ${item.title}`,
      `Summary: ${item.summary}`,
      `Customer: ${item.icp}`,
      `Problem: ${item.problem}`,
      `Change: ${item.change}`,
      `Measurable result: ${item.measurableResult}`,
      `Business model: ${item.businessModel}`,
      `Facts: ${facts === '' ? 'none' : facts}`,
      `Market context: ${market === '' ? 'none collected' : market}`,
      `Similar past cases: ${similarCases.length === 0 ? 'none' : similarCases.join(' | ')}`,
      '',
      'Excerpts:',
      ...excerpts.map((excerpt, index) => `E${String(index + 1)}. """${excerpt}"""`),
    ].join('\n'),
  maxOutputTokens: 3_000,
  // Worst case: ~10 000 input tokens (every field full) and 3 000 output (reasoning included)
  // on the dearest strong model.
  maxCostMicroUsd: 150_000,
  // Six calls per opportunity, a few opportunities a day: the rest of the day after the other
  // processes (D-021).
  dailyShare: 0.3,
  evalCases: cases,
  score: scoreJudge,
};
