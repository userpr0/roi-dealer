import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';

/*
 * D-030: the owner reads pains in Russian. The model translates the title and audience of a few
 * pains; code keeps an answer only for a known key, in Cyrillic and within the limits. The
 * original text stays the one used for matching.
 */

/** Pains in one call. */
export const MAX_TRANSLATE_PAINS = 5;
export const TITLE_RU_LENGTH = 200;
export const AUDIENCE_RU_LENGTH = 300;

const key = z.string().regex(/^P\d{1,2}$/);
const input = z.strictObject({
  pains: z
    .array(
      z.strictObject({
        key,
        title: z.string().min(1).max(200),
        audience: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(MAX_TRANSLATE_PAINS),
});
// Every field is required (strict structured output); limits are checked in code.
const output = z.strictObject({
  pains: z.array(
    z.strictObject({ key: z.string(), title_ru: z.string(), audience_ru: z.string() }),
  ),
});

export type TranslatePainsInput = z.infer<typeof input>;
export type TranslatePainsOutput = z.infer<typeof output>;

export interface PainTranslationDraft {
  readonly key: string;
  readonly titleRu: string;
  readonly audienceRu: string;
}

const CYRILLIC = /[А-Яа-яЁё]/;

function russian(text: string, max: number): string | undefined {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length === 0 || value.length > max || !CYRILLIC.test(value)) return undefined;
  return value;
}

/** The translations the code accepts: known keys, once each, Russian text within the limits. */
export function toPainTranslations(
  request: TranslatePainsInput,
  answer: TranslatePainsOutput,
): PainTranslationDraft[] {
  const keys = new Set(request.pains.map((pain) => pain.key));
  const result: PainTranslationDraft[] = [];
  const seen = new Set<string>();
  for (const item of answer.pains) {
    const itemKey = item.key.trim().toUpperCase();
    if (!keys.has(itemKey) || seen.has(itemKey)) continue;
    const titleRu = russian(item.title_ru, TITLE_RU_LENGTH);
    const audienceRu = russian(item.audience_ru, AUDIENCE_RU_LENGTH);
    if (titleRu === undefined || audienceRu === undefined) continue;
    seen.add(itemKey);
    result.push({ key: itemKey, titleRu, audienceRu });
  }
  return result;
}

const PAINS: readonly (readonly [title: string, audience: string])[] = [
  ['Freelancers struggle to get clients to pay invoices on time', 'Freelance designers'],
  ['Small agencies spend hours reconciling payouts with accounting software', 'Small agencies'],
  ['Clinics lose revenue because patients miss appointments', 'Dental clinics'],
  ['Startups lose enterprise deals because security questionnaires take too long', 'B2B startups'],
  ['Small teams burn out from noisy on-call alerts', 'Small engineering teams'],
  ['Support teams answer the same shipping questions every day', 'E-commerce support teams'],
  ['Online stores oversell because inventory does not sync across marketplaces', 'Online sellers'],
  ['Solo developers rewrite onboarding emails for every client', 'Freelance developers'],
  ['Landlords lose track of tenant repair requests sent by text', 'Small landlords'],
  ['Companies cannot track which SaaS tools former contractors can access', 'IT admins'],
  ['Startups waste money on job boards that bring irrelevant applicants', 'Startup founders'],
  ['Restaurants throw away food because weekday demand is unpredictable', 'Restaurant owners'],
  [
    'Developers struggle to keep context when switching between AI coding agents',
    'AI-assisted software developers',
  ],
  [
    'Small tech teams struggle to review the code that LLMs generate',
    'Small tech teams using LLMs',
  ],
  [
    'Job seekers are flooded with spam from automated platforms in job threads',
    'Job seekers on Hacker News',
  ],
  ['Website owners struggle with spam registrations that captchas do not stop', 'Website owners'],
  ['Sales teams get few replies to cold emails because they look like spam', 'Sales reps'],
  ['Podcast hosts spend hours editing out filler words', 'Podcasters'],
  ['Remote teams struggle to schedule meetings across time zones', 'Remote teams'],
  ['Accountants spend hours matching Stripe payouts to bookkeeping entries', 'Accountants'],
  ['Shopify merchants refund orders because inventory counts are wrong', 'Shopify merchants'],
  ['Teachers spend evenings grading the same kinds of mistakes', 'School teachers'],
];

// 22 cases: one to three pains each, every pain at least once.
const cases = PAINS.map((_, index) => {
  const size = (index % 3) + 1;
  const pains = Array.from({ length: size }, (__, offset) => {
    const [title, audience] = PAINS[(index + offset) % PAINS.length] ?? PAINS[0] ?? ['', ''];
    return { key: `P${String(offset + 1)}`, title, audience };
  });
  return { input: { pains }, expected: pains.map((pain) => pain.key) };
});

export function scoreTranslatePains(
  results: readonly {
    readonly expected: readonly string[];
    readonly output: TranslatePainsOutput | undefined;
  }[],
): EvalScore {
  let complete = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    const pains = expected.map((painKey) => ({ key: painKey, title: 'x', audience: 'x' }));
    const accepted = new Set(toPainTranslations({ pains }, answer).map((item) => item.key));
    if (expected.every((painKey) => accepted.has(painKey))) complete += 1;
  }
  const completeShare = results.length === 0 ? 0 : complete / results.length;
  const answeredShare = results.length === 0 ? 0 : answered / results.length;
  return {
    passed: completeShare >= 0.9 && answeredShare >= 0.9,
    metrics: { complete: completeShare, answered: answeredShare },
  };
}

export const translatePainsTask: AiTask<
  TranslatePainsInput,
  TranslatePainsOutput,
  readonly string[]
> = {
  name: 'translate-pains',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You translate short descriptions of business problems into Russian for a business owner.',
    'For every pain return its key unchanged and:',
    '- title_ru: the problem in natural Russian, one sentence, up to 200 characters;',
    '- audience_ru: who has it, in Russian, a few words.',
    'Keep product and company names as they are. Do not add facts, opinions or advice.',
  ].join('\n'),
  input,
  output,
  render: ({ pains }) =>
    [
      'Pains:',
      ...pains.map((pain) => `${pain.key}: ${pain.title} (audience: ${pain.audience})`),
    ].join('\n'),
  maxOutputTokens: 1_200,
  // Worst case: five pains at full length (~2 600 input tokens) and 1 200 output tokens on the
  // dearest bulk model.
  maxCostMicroUsd: 8_000,
  // A few calls a day: new pains plus the ones found before D-030, five at a time.
  dailyShare: 0.02,
  evalCases: cases,
  score: scoreTranslatePains,
};
