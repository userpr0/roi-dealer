import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';

/*
 * PHASE 06: is a new pain statement the same pain as one of the closest candidates? The model
 * answers with a short key; code maps it back and treats an unknown key as "none" (§2.3).
 */

export const NO_MATCH = 'none';
export const MAX_MATCH_CANDIDATES = 10;

const statement = z.string().min(1).max(300);
const audience = z.string().min(1).max(200);
const input = z.strictObject({
  statement,
  audience,
  candidates: z
    .array(z.strictObject({ key: z.string().regex(/^P\d{1,2}$/), statement, audience }))
    .min(1)
    .max(MAX_MATCH_CANDIDATES),
});
const output = z.strictObject({ match: z.string() });

export type MatchPainInput = z.infer<typeof input>;
export type MatchPainOutput = z.infer<typeof output>;

type Candidate = readonly [statement: string, audience: string];
const golden: readonly (readonly [Candidate, readonly Candidate[], string])[] = [
  [
    ['Freelancers struggle to get clients to pay invoices on time', 'Freelance designers'],
    [
      ['Small agencies spend hours reconciling payouts with accounting software', 'Small agencies'],
      ['Freelancers waste time chasing late client payments', 'Freelancers'],
    ],
    'P2',
  ],
  [
    ['Clinics lose revenue because patients miss appointments', 'Dental clinics'],
    [
      ['Restaurants waste food because they cannot forecast demand', 'Restaurant owners'],
      ['Medical practices suffer from patient no-shows despite SMS reminders', 'Medical practices'],
    ],
    'P2',
  ],
  [
    [
      'Startups lose enterprise deals because security questionnaires take too long',
      'B2B startups',
    ],
    [
      ['Small teams burn out from noisy on-call alerts', 'Small engineering teams'],
      ['Companies cannot track which SaaS tools former contractors can access', 'IT admins'],
    ],
    NO_MATCH,
  ],
  [
    [
      'E-commerce sellers oversell because stock does not sync between Shopify and Amazon',
      'Multichannel sellers',
    ],
    [
      [
        'Online stores oversell items when inventory is not synchronized across marketplaces',
        'Online store owners',
      ],
      ['Support teams answer the same shipping questions repeatedly', 'E-commerce support'],
    ],
    'P1',
  ],
  [
    ['Landlords lose track of tenant repair requests sent by text', 'Small landlords'],
    [
      [
        'Property managers struggle to track maintenance requests from tenants',
        'Property managers',
      ],
      ['Freelancers waste time chasing late client payments', 'Freelancers'],
    ],
    'P1',
  ],
  [
    ['Small teams get woken up at night by false alerts', 'Small engineering teams'],
    [
      ['On-call engineers in small teams burn out from noisy alerts', 'On-call engineers'],
      ['Startups lose deals because of slow security questionnaires', 'B2B startups'],
      ['Developers rewrite onboarding emails for every client', 'Freelance developers'],
    ],
    'P1',
  ],
  [
    ['Restaurants throw away food because weekday demand is unpredictable', 'Restaurant owners'],
    [
      ['Clinics lose revenue because patients miss appointments', 'Clinics'],
      ['Retail shops cannot forecast how many staff they need', 'Retail shop owners'],
    ],
    NO_MATCH,
  ],
  [
    ['Startups spend thousands on job boards and get irrelevant applicants', 'Startup founders'],
    [
      [
        'Small companies waste money on job ads that attract unqualified candidates',
        'Small companies',
      ],
      ['Agencies spend hours reconciling payouts', 'Agencies'],
    ],
    'P1',
  ],
  [
    ['Support teams are overwhelmed by repetitive shipping questions', 'E-commerce support teams'],
    [
      [
        'Online stores receive the same customer questions about delivery every day',
        'Online stores',
      ],
      ['Sellers oversell because inventory does not sync', 'Online sellers'],
    ],
    'P1',
  ],
  [
    ['Accountants spend hours matching Stripe payouts to bookkeeping entries', 'Accountants'],
    [
      ['Freelancers waste time chasing late client payments', 'Freelancers'],
      ['Small agencies spend hours reconciling payouts with accounting software', 'Small agencies'],
    ],
    'P2',
  ],
  [
    [
      'Companies do not know which SaaS accounts departing contractors still have',
      'IT admins at small companies',
    ],
    [
      ['Offboarding contractors leaves unknown admin access to SaaS tools', 'Small companies'],
      ['Small teams burn out from on-call alerts', 'Small engineering teams'],
    ],
    'P1',
  ],
  [
    ['Freelance writers struggle to find new clients', 'Freelance writers'],
    [
      ['Freelancers waste time chasing late client payments', 'Freelancers'],
      ['Agencies spend hours reconciling payouts', 'Agencies'],
    ],
    NO_MATCH,
  ],
  [
    ['Patients often skip booked appointments at small clinics', 'Small clinics'],
    [
      ['Medical practices suffer from patient no-shows despite SMS reminders', 'Medical practices'],
      ['Restaurants waste food because they cannot forecast demand', 'Restaurant owners'],
    ],
    'P1',
  ],
  [
    ['Podcast hosts spend hours editing out filler words', 'Podcasters'],
    [
      ['Video creators spend too long adding subtitles', 'Video creators'],
      ['Developers rewrite onboarding emails for every client', 'Freelance developers'],
    ],
    NO_MATCH,
  ],
  [
    [
      'Freelance developers rewrite the same onboarding emails for every new client',
      'Freelance developers',
    ],
    [
      [
        'Solo developers waste hours rewriting onboarding emails for each client project',
        'Solo developers',
      ],
      ['Landlords lose track of repair requests', 'Small landlords'],
    ],
    'P1',
  ],
  [
    [
      'Hiring managers at small startups get flooded with irrelevant applications',
      'Startup hiring managers',
    ],
    [
      ['Companies cannot track SaaS access of contractors', 'IT admins'],
      ['Small teams burn out on call', 'Small engineering teams'],
    ],
    NO_MATCH,
  ],
  [
    ['Shopify merchants refund orders because inventory counts are wrong', 'Shopify merchants'],
    [
      [
        'Online stores oversell items when inventory is not synchronized across marketplaces',
        'Online store owners',
      ],
      ['Support teams answer the same shipping questions', 'E-commerce support'],
      ['Restaurants waste food because they cannot forecast demand', 'Restaurant owners'],
    ],
    'P1',
  ],
  [
    ['Restaurant owners cannot predict how many guests will come', 'Restaurant owners'],
    [
      [
        'Restaurants throw away food because weekday demand is hard to predict',
        'Restaurant owners',
      ],
      ['Clinics lose revenue from no-shows', 'Clinics'],
    ],
    'P1',
  ],
  [
    ['Remote teams struggle to schedule meetings across time zones', 'Remote teams'],
    [
      ['Small teams burn out from noisy on-call alerts', 'Small engineering teams'],
      ['Freelancers waste time chasing late client payments', 'Freelancers'],
    ],
    NO_MATCH,
  ],
  [
    [
      'B2B startups cannot answer security questionnaires fast enough to close deals',
      'B2B startups',
    ],
    [
      [
        'Startups lose enterprise deals because security reviews take too long',
        'Early-stage B2B startups',
      ],
      ['Companies cannot track SaaS access', 'IT admins'],
    ],
    'P1',
  ],
];

const cases = golden.map(([[newStatement, newAudience], candidates, expected]) => ({
  input: {
    statement: newStatement,
    audience: newAudience,
    candidates: candidates.map(([candidateStatement, candidateAudience], index) => ({
      key: `P${String(index + 1)}`,
      statement: candidateStatement,
      audience: candidateAudience,
    })),
  },
  expected,
}));

/** The candidate key the answer names, or `none` for anything else. */
export function matchedKey(answer: MatchPainOutput, keys: readonly string[]): string {
  const key = answer.match.trim().toUpperCase();
  return keys.includes(key) ? key : NO_MATCH;
}

export function scoreMatchPain(
  results: readonly { readonly expected: string; readonly output: MatchPainOutput | undefined }[],
): EvalScore {
  let correct = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    const keys = Array.from(
      { length: MAX_MATCH_CANDIDATES },
      (_, index) => `P${String(index + 1)}`,
    );
    if (matchedKey(answer, keys) === expected) correct += 1;
  }
  const accuracy = results.length === 0 ? 0 : correct / results.length;
  const answeredShare = results.length === 0 ? 0 : answered / results.length;
  return {
    passed: accuracy >= 0.85 && answeredShare >= 0.9,
    metrics: { accuracy, answered: answeredShare },
  };
}

export const matchPainTask: AiTask<MatchPainInput, MatchPainOutput, string> = {
  name: 'match-pain',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You compare a new problem with candidate pains found earlier.',
    'It is the same pain when the same kind of people have the same underlying problem, even if',
    'it is worded differently. A different audience or a different problem is not the same pain.',
    'Answer with the key of the one matching candidate (for example P2), or none.',
  ].join('\n'),
  input,
  output,
  render: ({ statement: newStatement, audience: newAudience, candidates }) =>
    [
      'New problem:',
      `- statement: ${newStatement}`,
      `- audience: ${newAudience}`,
      '',
      'Candidate pains:',
      ...candidates.map(
        (candidate) => `${candidate.key}: ${candidate.statement} (audience: ${candidate.audience})`,
      ),
    ].join('\n'),
  maxOutputTokens: 512,
  // Worst case: ten candidates at full length (~6 300 input tokens) and 512 output tokens on
  // the dearest bulk model.
  maxCostMicroUsd: 8_000,
  dailyShare: 0.05,
  evalCases: cases,
  score: scoreMatchPain,
};
