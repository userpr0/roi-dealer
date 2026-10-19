import { describe, expect, it } from 'vitest';
import {
  approveMediaAsset,
  createMediaAsset,
  experimentIdSchema,
  hypothesisIdSchema,
  MEDIA_SLUG_PATTERN,
  mediaAssetIdSchema,
  opportunityIdSchema,
  PREVIEW_TOKEN_PATTERN,
  rejectMediaAsset,
  usd,
} from '@roi-dealer/domain';
import {
  checkLanding,
  landingDisclosure,
  landingSlug,
  newPreviewToken,
  priceLabel,
  renderLanding,
  scoreWriteLanding,
  writeLandingTask,
  type WriteLandingInput,
  type WriteLandingOutput,
} from '@roi-dealer/media';
import { AGENT, createCtx, ctx, OWNER } from '../../support/domain.js';
import { perfectLandingAnswer } from '../../support/media-answers.js';

const material: WriteLandingInput = {
  opportunity: {
    title: 'Invoices that get paid without chasing',
    icp: 'Freelancers and two-person studios',
    problem: 'Clients pay invoices late',
    change: 'Reminders and follow-ups run on their own',
    measurableResult: 'Save $20 a month and 6 hours a week',
  },
  hypothesis: {
    audience: 'Freelancers in the US',
    offer: 'Automatic invoice reminders, $12 a month',
    priceUsd: 12,
    channel: 'Reddit r/freelance',
    creative: 'Get paid on time',
    cta: 'Join the waitlist',
    method: 'waitlist',
  },
  rejectedHeadline: '',
  feedback: '',
};

function answer(change: Partial<WriteLandingOutput> = {}): WriteLandingOutput {
  return { ...perfectLandingAnswer(material), ...change };
}

const issues = (value: WriteLandingOutput, input: WriteLandingInput = material): string[] => {
  const checked = checkLanding(input, value);
  return 'issues' in checked ? checked.issues : [];
};

describe('the checks of a landing (PHASE 19a, §2.13, §2.17)', () => {
  it('keeps a page about the customer and adds the price and honesty note from code', () => {
    const checked = checkLanding(material, answer());
    if (!('content' in checked)) throw new Error(checked.issues.join('; '));
    expect(checked.content).toMatchObject({
      price: usd(1_200),
      pricePeriod: 'per_month',
      disclosure: 'in_development',
      cta: 'Join the waitlist',
    });
    // Audience words with numbers are not claims.
    expect(issues(answer({ subheadline: 'For teams of 5–50 people who send invoices.' }))).toEqual(
      [],
    );
  });

  it('rejects invented proof', () => {
    for (const [text, what] of [
      ['Customers love it: real testimonials inside', 'reviews or testimonials'],
      ['Trusted by top studios', 'borrowed trust'],
      ['Join 2,000+ freelancers today', 'user counts'],
      ['Rated 4.9 stars', 'ratings'],
      ['Award-winning reminders', 'awards'],
      ['Guaranteed payment or your money back', 'guarantees'],
      ['Only 3 spots left', 'fake scarcity'],
      ['The #1 invoice tool', 'unbacked superlatives'],
    ] as const) {
      expect(issues(answer({ headline: text })).join('; ')).toContain(`headline: no ${what}`);
    }
  });

  it('takes money and result numbers only from the input', () => {
    expect(issues(answer({ headline: 'Pay just $9 a month' }))).toContain(
      'headline: no money amounts (the page shows the price itself)',
    );
    expect(issues(answer({ headline: 'Save 10 hours a week' }))).toContain(
      'headline: no result numbers the input does not give',
    );
    // Both are in the promised result of the input.
    expect(issues(answer({ headline: 'Save $20 a month and 6 hours a week' }))).toEqual([]);
  });

  it('rejects links, contacts, other languages and parts out of range', () => {
    expect(issues(answer({ cta: 'Visit invoices.com' }))).toContain(
      'cta: no links, emails or phone numbers',
    );
    expect(issues(answer({ problem: 'Write to hello@example.org' }))).toContain(
      'problem: no links, emails or phone numbers',
    );
    expect(issues(answer({ headline: 'Счета оплачиваются вовремя' }))).toContain(
      'headline: write in English',
    );
    expect(issues(answer({ headline: 'x'.repeat(91) }))).toContain(
      'headline is 91 characters, at most 90',
    );
    expect(issues(answer({ steps: ['One', 'Two'] }))).toContain('write exactly 3 steps');
    expect(issues(answer({ faq: [] }))).toContain('write 2 to 4 questions');
    expect(issues(answer({ cta: '  ' }))).toContain('cta is empty');
  });

  it('sets the honesty note and the price label in code', () => {
    expect(landingDisclosure('preorder')).toBe('preorder');
    expect(landingDisclosure('landing_page')).toBe('in_development');
    expect(landingDisclosure('ads_test')).toBe('in_development');
    expect(priceLabel(usd(1_200), 'per_month')).toBe('$12.00 / month');
    expect(priceLabel(usd(4_900), 'one_time')).toBe('$49.00');
    expect(priceLabel(usd(500), 'per_user_month')).toBe('$5.00 per user / month');
    expect(priceLabel(usd(0), 'per_month')).toBe('Free while in early access');
    const preorder = checkLanding(
      { ...material, hypothesis: { ...material.hypothesis, method: 'preorder' } },
      answer(),
    );
    expect('content' in preorder && preorder.content.disclosure).toBe('preorder');
  });
});

describe('the landing page (PHASE 19a)', () => {
  const content = (() => {
    const checked = checkLanding(material, answer());
    if (!('content' in checked)) throw new Error('invalid');
    return checked.content;
  })();

  it('is static: no scripts, no external resources, every text escaped', () => {
    const evil = { ...content, headline: '<script>alert(1)</script> & "quotes"' };
    const html = renderLanding(evil, { mode: 'public', ctaHref: '/l/x/go?a=1&b=2' });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).toContain('href="/l/x/go?a=1&amp;b=2"');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('$12.00 / month');
    expect(html).toContain('We are building this now.');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('shows a banner and an inactive button in the preview', () => {
    const html = renderLanding(content, { mode: 'preview', ctaHref: '/somewhere' });
    expect(html).toContain('Preview — this page is not public yet.');
    expect(html).toContain('<a class="cta" aria-disabled="true">Join the waitlist</a>');
    expect(html).not.toContain('/somewhere');
  });

  it('gets a readable slug and an unguessable preview token', () => {
    const id = '0192f4c2-1111-7000-8000-00000000abcd';
    expect(landingSlug('Invoices that get paid — without chasing!', id)).toBe(
      'invoices-that-get-paid-without-chasing-0000abcd',
    );
    expect(landingSlug('Счета', id)).toBe('landing-0000abcd');
    expect(landingSlug('x'.repeat(200), id)).toMatch(MEDIA_SLUG_PATTERN);
    const token = newPreviewToken();
    expect(token).toMatch(PREVIEW_TOKEN_PATTERN);
    expect(newPreviewToken()).not.toBe(token);
  });
});

describe('the write-landing task (PHASE 09 rules)', () => {
  it('has a golden set of 20 and a score that needs valid pages about the customer', () => {
    expect(writeLandingTask.evalCases.length).toBeGreaterThanOrEqual(20);
    expect(writeLandingTask.tier).toBe('bulk');
    const perfect = writeLandingTask.evalCases.map((item) => ({
      expected: item.expected,
      output: perfectLandingAnswer(item.expected.material),
    }));
    expect(scoreWriteLanding(perfect)).toMatchObject({ passed: true, metrics: { valid: 1 } });
    const invented = perfect.map((item) => ({
      ...item,
      output: { ...item.output, headline: 'Trusted by 2,000+ teams' },
    }));
    expect(scoreWriteLanding(invented)).toMatchObject({ passed: false, metrics: { valid: 0 } });
    const silent = perfect.map((item) => ({ ...item, output: undefined }));
    expect(scoreWriteLanding(silent).passed).toBe(false);
  });
});

describe('MediaAsset (PHASE 19a, §2.3)', () => {
  const checked = checkLanding(material, answer());
  if (!('content' in checked)) throw new Error('invalid');
  const draft = createMediaAsset(
    {
      kind: 'landing',
      experimentId: experimentIdSchema.parse('0192f4c2-1111-7000-8000-000000000001'),
      hypothesisId: hypothesisIdSchema.parse('0192f4c2-1111-7000-8000-000000000002'),
      opportunityId: opportunityIdSchema.parse('0192f4c2-1111-7000-8000-000000000003'),
      content: checked.content,
      slug: 'invoices-that-get-paid-0000abcd',
      previewToken: newPreviewToken(),
    },
    createCtx(mediaAssetIdSchema, AGENT, 1),
  );

  it('is written as a draft; only the owner approves or rejects it', () => {
    expect(draft.status).toBe('draft');
    expect(() => approveMediaAsset(draft, ctx(AGENT, 2))).toThrow(/owner/i);
    expect(() => rejectMediaAsset(draft, ctx(AGENT, 2))).toThrow(/owner/i);
    expect(approveMediaAsset(draft, ctx(OWNER, 2)).status).toBe('approved');
    const rejected = rejectMediaAsset(draft, ctx(OWNER, 2));
    expect(rejected.status).toBe('rejected');
    expect(() => approveMediaAsset(rejected, ctx(OWNER, 3))).toThrow();
  });
});
