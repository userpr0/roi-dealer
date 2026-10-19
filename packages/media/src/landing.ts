import {
  containsContactData,
  formatUsd,
  LANDING_LIMITS,
  LANDING_PARTS,
  landingContentSchema,
  type LandingContent,
  type LandingDisclosure,
  type Money,
  type PricePeriod,
  type Hypothesis,
} from '@roi-dealer/domain';

type ValidationMethod = Hypothesis['validationMethod'];

/*
 * The checks of a landing the model wrote (PHASE 19a, §2.13, §2.17): every part present and
 * within its limit, no invented proof (reviews, user counts, ratings, awards, guarantees, fake
 * scarcity), no money amounts the input does not contain, no links or contacts, English only.
 * The price and the honesty note are added by code.
 */

/** What the model returns; the price and the honesty note are not part of it. */
export interface LandingAnswer {
  readonly headline: string;
  readonly subheadline: string;
  readonly problem: string;
  readonly benefits: readonly { readonly title: string; readonly text: string }[];
  readonly steps: readonly string[];
  readonly offer: string;
  readonly pricePeriod: PricePeriod;
  readonly cta: string;
  readonly faq: readonly { readonly question: string; readonly answer: string }[];
  readonly ads: readonly { readonly headline: string; readonly body: string }[];
}

/** Claims that need proof the system does not have (§2.17, D-014 п.8). */
const FABRICATION: readonly (readonly [RegExp, string])[] = [
  [
    /\btestimonials?\b|\b(customers?|users?|clients?)\s+(reviews?|say|love)\b|\b\d+\s*\+?\s*reviews?\b/i,
    'reviews or testimonials',
  ],
  [/trusted by|as seen (on|in)|featured (in|on)/i, 'borrowed trust'],
  [
    /\bjoin\s+(over\s+)?[\d,.]+|\b[\d,.]+\s*\+\s*(customers|users|teams|companies|businesses|clients)\b|\b(over|more than)\s+[\d,.]+\s+(customers|users|teams|companies|businesses|clients)\b|\b[\d,.]+\s+(happy|satisfied)\b/i,
    'user counts',
  ],
  [/★|⭐|\b\d(\.\d)?\s*(\/\s*5|out of 5|stars?)\b|\b(top|highly|5-star)[- ]rated\b/i, 'ratings'],
  [/\baward/i, 'awards'],
  [/guarantee|risk[- ]free|money[- ]back/i, 'guarantees (the refund note is added by code)'],
  [
    /\b(only|just)\s+\d+\s+(left|spots?|seats?|places?)\b|limited time|ends (today|tonight|soon)|\bhurry\b/i,
    'fake scarcity',
  ],
  [
    /#\s?1\b|number one|world'?s (best|first|leading)|industry'?s (best|first|leading)|best[- ]in[- ]class/i,
    'unbacked superlatives',
  ],
];

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|ai|net|org|co|app|dev)\b/i;
/** Money and result numbers: allowed only when the input says them (§2.13). */
const CLAIMED_NUMBERS: readonly (readonly [RegExp, string])[] = [
  [
    /\$\s?\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s?(usd|dollars?|eur|euros?|gbp|€|£)/gi,
    'no money amounts (the page shows the price itself)',
  ],
  [
    /\b\d[\d,.]*\s*(%|percent\b|hours?\b|hrs?\b|minutes?\b|mins?\b|days?\b|weeks?\b|months?\b|x\b|times\b)/gi,
    'no result numbers the input does not give',
  ],
];
const NON_LATIN =
  /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

const normalizeClaim = (text: string): string => text.replace(/[\s,]/g, '').toLowerCase();

/** `preorder` takes money in advance; every other page asks for an email (D-014 п.8). */
export function landingDisclosure(method: ValidationMethod): LandingDisclosure {
  return method === 'preorder' ? 'preorder' : 'in_development';
}

const PERIOD_LABELS: Readonly<Record<PricePeriod, string>> = {
  one_time: '',
  per_month: ' / month',
  per_year: ' / year',
  per_user_month: ' per user / month',
};

/** The price as the page shows it, from the hypothesis (§2.13). */
export function priceLabel(price: Money, period: PricePeriod): string {
  if (price.amountCents === 0) return 'Free while in early access';
  return `${formatUsd(price)}${PERIOD_LABELS[period]}`;
}

/** The honesty note under the offer (English: the pages are for D-008 markets). */
export function disclosureText(disclosure: LandingDisclosure): string {
  return disclosure === 'preorder'
    ? 'This is a preorder: you pay now and get it as soon as it is ready. If we do not deliver, you get a full refund.'
    : 'We are building this now. Leave your email and we will let you know when it is ready. No payment today.';
}

function texts(answer: LandingAnswer): readonly (readonly [string, string])[] {
  return [
    ['headline', answer.headline],
    ['subheadline', answer.subheadline],
    ['problem', answer.problem],
    ...answer.benefits.flatMap((item, index): [string, string][] => [
      [`benefit ${String(index + 1)} title`, item.title],
      [`benefit ${String(index + 1)} text`, item.text],
    ]),
    ...answer.steps.map((step, index): [string, string] => [`step ${String(index + 1)}`, step]),
    ['offer', answer.offer],
    ['cta', answer.cta],
    ...answer.faq.flatMap((item, index): [string, string][] => [
      [`question ${String(index + 1)}`, item.question],
      [`answer ${String(index + 1)}`, item.answer],
    ]),
    ...answer.ads.flatMap((item, index): [string, string][] => [
      [`ad ${String(index + 1)} headline`, item.headline],
      [`ad ${String(index + 1)} body`, item.body],
    ]),
  ];
}

function limitIssues(answer: LandingAnswer): string[] {
  const issues: string[] = [];
  const check = (field: string, value: string, max: number) => {
    const length = value.trim().length;
    if (length === 0) issues.push(`${field} is empty`);
    else if (length > max)
      issues.push(`${field} is ${String(length)} characters, at most ${String(max)}`);
  };
  check('headline', answer.headline, LANDING_LIMITS.headline);
  check('subheadline', answer.subheadline, LANDING_LIMITS.subheadline);
  check('problem', answer.problem, LANDING_LIMITS.problem);
  check('offer', answer.offer, LANDING_LIMITS.offer);
  check('cta', answer.cta, LANDING_LIMITS.cta);
  if (answer.benefits.length !== LANDING_PARTS.benefits) {
    issues.push(`write exactly ${String(LANDING_PARTS.benefits)} benefits`);
  }
  answer.benefits.forEach((item, index) => {
    check(`benefit ${String(index + 1)} title`, item.title, LANDING_LIMITS.benefitTitle);
    check(`benefit ${String(index + 1)} text`, item.text, LANDING_LIMITS.benefitText);
  });
  if (answer.steps.length !== LANDING_PARTS.steps) {
    issues.push(`write exactly ${String(LANDING_PARTS.steps)} steps`);
  }
  answer.steps.forEach((step, index) => {
    check(`step ${String(index + 1)}`, step, LANDING_LIMITS.step);
  });
  if (answer.faq.length < LANDING_PARTS.minFaq || answer.faq.length > LANDING_PARTS.maxFaq) {
    issues.push(
      `write ${String(LANDING_PARTS.minFaq)} to ${String(LANDING_PARTS.maxFaq)} questions`,
    );
  }
  answer.faq.forEach((item, index) => {
    check(`question ${String(index + 1)}`, item.question, LANDING_LIMITS.question);
    check(`answer ${String(index + 1)}`, item.answer, LANDING_LIMITS.answer);
  });
  if (answer.ads.length !== LANDING_PARTS.ads) {
    issues.push(`write exactly ${String(LANDING_PARTS.ads)} ads`);
  }
  answer.ads.forEach((item, index) => {
    check(`ad ${String(index + 1)} headline`, item.headline, LANDING_LIMITS.adHeadline);
    check(`ad ${String(index + 1)} body`, item.body, LANDING_LIMITS.adBody);
  });
  return issues;
}

/**
 * The checked content of the page, or the issues to fix. `source` is the input text money
 * and result numbers may come from (the promised result, the offer); `price` and `disclosure` are
 * set by code.
 */
export function toLandingContent(
  answer: LandingAnswer,
  context: {
    readonly price: Money;
    readonly disclosure: LandingDisclosure;
    readonly source: string;
  },
): { readonly content: LandingContent } | { readonly issues: string[] } {
  const issues = limitIssues(answer);
  const allowed = new Set(
    CLAIMED_NUMBERS.flatMap(([pattern]) =>
      [...context.source.matchAll(pattern)].map((match) => normalizeClaim(match[0])),
    ),
  );
  for (const [field, value] of texts(answer)) {
    for (const [pattern, what] of FABRICATION) {
      if (pattern.test(value)) issues.push(`${field}: no ${what}`);
    }
    if (LINK.test(value) || containsContactData(value)) {
      issues.push(`${field}: no links, emails or phone numbers`);
    }
    for (const [pattern, what] of CLAIMED_NUMBERS) {
      for (const match of value.matchAll(pattern)) {
        if (!allowed.has(normalizeClaim(match[0]))) {
          issues.push(`${field}: ${what}`);
          break;
        }
      }
    }
    if (NON_LATIN.test(value)) issues.push(`${field}: write in English`);
  }
  if (issues.length > 0) return { issues: [...new Set(issues)] };
  const parsed = landingContentSchema.safeParse({
    headline: answer.headline,
    subheadline: answer.subheadline,
    problem: answer.problem,
    benefits: answer.benefits,
    steps: answer.steps,
    offer: answer.offer,
    price: context.price,
    pricePeriod: answer.pricePeriod,
    cta: answer.cta,
    faq: answer.faq,
    ads: answer.ads,
    disclosure: context.disclosure,
  });
  return parsed.success ? { content: parsed.data } : { issues: ['parts are out of range'] };
}
