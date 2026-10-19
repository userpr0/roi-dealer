import { describe, expect, it } from 'vitest';
import type { Database } from '@roi-dealer/database';
import {
  approveMediaAsset,
  createMediaAsset,
  experimentIdSchema,
  funnelMetric,
  hypothesisIdSchema,
  mediaAssetIdSchema,
  opportunityIdSchema,
  releaseGate,
  releaseMediaAsset,
  usd,
  type FunnelEvent,
  type ReleaseFacts,
} from '@roi-dealer/domain';
import { checkLanding, isStaticPage, newPreviewToken, renderLanding } from '@roi-dealer/media';
import { createHealthRegistry } from '@roi-dealer/observability';
import { createSiteTracker, isVisit, utmOf, type SiteVisit } from '@roi-dealer/site';
import { createRouter, loggedPath, visitOf } from '../../../apps/api/src/router.js';
import { AGENT, createCtx, ctx, OWNER } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';
import { perfectLandingAnswer } from '../../support/media-answers.js';

const material = {
  opportunity: {
    title: 'Invoices that get paid',
    icp: 'Freelancers',
    problem: 'Clients pay late',
    change: 'Reminders run on their own',
    measurableResult: 'A day a month back',
  },
  hypothesis: {
    audience: 'Freelancers in the US',
    offer: 'Automatic reminders',
    priceUsd: 12,
    channel: 'Reddit ads',
    creative: 'Get paid on time',
    cta: 'Join the waitlist',
    method: 'waitlist' as const,
  },
  rejectedHeadline: '',
  feedback: '',
};

function landingContent(method: 'waitlist' | 'preorder' = 'waitlist') {
  const input = { ...material, hypothesis: { ...material.hypothesis, method } };
  const checked = checkLanding(input, perfectLandingAnswer(input));
  if (!('content' in checked)) throw new Error(checked.issues.join('; '));
  return checked.content;
}

const draft = createMediaAsset(
  {
    kind: 'landing',
    experimentId: experimentIdSchema.parse('0192f4c2-1111-7000-8000-000000000001'),
    hypothesisId: hypothesisIdSchema.parse('0192f4c2-1111-7000-8000-000000000002'),
    opportunityId: opportunityIdSchema.parse('0192f4c2-1111-7000-8000-000000000003'),
    content: landingContent(),
    slug: 'invoices-that-get-paid-0000abcd',
    previewToken: newPreviewToken(),
  },
  createCtx(mediaAssetIdSchema, AGENT, 1),
);
const approved = approveMediaAsset(draft, ctx(OWNER, 2));

function facts(change: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return {
    asset: approved,
    experiment: {
      status: 'approved',
      successMetric: funnelMetric({ stage: 'lead' }, 20),
      stopLoss: usd(2_000),
      checksConfirmedAt: ctx(OWNER, 1).at,
    },
    hypothesis: { validationMethod: 'waitlist', price: usd(1_200) },
    trackerActive: true,
    pageStatic: true,
    checkoutReady: false,
    ...change,
  };
}

const failed = (value: ReleaseFacts) =>
  releaseGate(value)
    .filter((item) => !item.passed)
    .map((item) => item.check);

describe('the Release Gate (PHASE 21, §7.2)', () => {
  it('passes an approved page of an approved launch with a working counter', () => {
    expect(releaseGate(facts()).map((item) => item.check)).toEqual([
      'page_approved',
      'launch_approved',
      'metric_fixed',
      'honest_checks',
      'tracking',
      'page_static',
    ]);
    expect(failed(facts())).toEqual([]);
  });

  it('names every failed check', () => {
    expect(
      failed(
        facts({
          asset: draft,
          experiment: {
            status: 'planned',
            successMetric: { name: 'happiness', target: 5, unit: '%', direction: 'at_least' },
            stopLoss: usd(2_000),
            checksConfirmedAt: undefined,
          },
          trackerActive: false,
          pageStatic: false,
        }),
      ),
    ).toEqual([
      'page_approved',
      'launch_approved',
      'metric_fixed',
      'honest_checks',
      'tracking',
      'page_static',
    ]);
  });

  it('needs a tested checkout and the refund note for a paid preorder', () => {
    const preorder = facts({
      asset: { ...approved, content: landingContent('preorder') },
      hypothesis: { validationMethod: 'preorder', price: usd(4_900) },
    });
    expect(releaseGate(preorder).filter((item) => !item.passed)).toEqual([
      { check: 'payment_flow', passed: false },
    ]);
    expect(failed({ ...preorder, checkoutReady: true })).toEqual([]);
    expect(failed({ ...preorder, asset: approved })).toEqual(['payment_flow', 'refund_terms']);
  });

  it('lets only the owner release, after the gate and both confirmations', () => {
    expect(() =>
      releaseMediaAsset(approved, facts(), ['crash_test', 'no_blockers'], ctx(AGENT, 3)),
    ).toThrow(/owner/i);
    expect(() =>
      releaseMediaAsset(
        approved,
        facts({ trackerActive: false }),
        ['crash_test', 'no_blockers'],
        ctx(OWNER, 3),
      ),
    ).toThrow(/gate/);
    expect(() => releaseMediaAsset(approved, facts(), ['crash_test'], ctx(OWNER, 3))).toThrow(
      /confirmed/,
    );
    const released = releaseMediaAsset(
      approved,
      facts(),
      ['no_blockers', 'crash_test'],
      ctx(OWNER, 3),
    );
    expect(released).toMatchObject({
      status: 'released',
      releaseChecks: ['crash_test', 'no_blockers'],
      releasedAt: ctx(OWNER, 3).at,
      version: approved.version + 1,
    });
    expect(() =>
      releaseMediaAsset(draft, facts(), ['crash_test', 'no_blockers'], ctx(OWNER, 3)),
    ).toThrow();
  });

  it('sees whether the public page is static', () => {
    const html = renderLanding(landingContent(), { mode: 'public', ctaHref: '/l/x/go' });
    expect(isStaticPage(html)).toBe(true);
    for (const injected of [
      '<script>alert(1)</script>',
      '<img src=x>',
      '<a href="https://evil.example">x</a>',
      '<a href="javascript:alert(1)">x</a>',
      '<div onclick=alert(1)>x</div>',
      '<link rel="stylesheet" href="/x.css">',
    ]) {
      expect(isStaticPage(html.replace('</main>', `${injected}</main>`))).toBe(false);
    }
  });
});

describe('the page counter (PHASE 21)', () => {
  const browser: SiteVisit = {
    method: 'GET',
    query: {},
    userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15',
    address: '203.0.113.9',
  };

  it('counts only a person’s GET, not robots, previews or prefetches', () => {
    expect(isVisit(browser)).toBe(true);
    expect(isVisit({ ...browser, method: 'HEAD' })).toBe(false);
    expect(isVisit({ ...browser, userAgent: undefined })).toBe(false);
    for (const agent of [
      'TelegramBot (like TwitterBot)',
      'Slackbot-LinkExpanding 1.0',
      'facebookexternalhit/1.1',
      'Googlebot/2.1',
      'curl/8.5.0',
      'Mozilla/5.0 HeadlessChrome/120.0',
    ]) {
      expect(isVisit({ ...browser, userAgent: agent })).toBe(false);
    }
    expect(isVisit({ ...browser, purpose: 'prefetch' })).toBe(false);
  });

  it('keeps only valid UTM tags', () => {
    expect(
      utmOf({
        utm_source: ' reddit ',
        utm_campaign: 'x'.repeat(101),
        utm_term: '   ',
        ref: 'other',
      }),
    ).toEqual({ source: 'reddit' });
  });

  it('records a visitor once per window and stops at the limit of the minute', async () => {
    const recorded: FunnelEvent[] = [];
    let clock = 1_000_000;
    const database = {
      repositories: {
        systemControls: {
          getById: () => Promise.resolve({ key: 'automation', status: 'running' }),
        },
        principals: { getByActor: () => Promise.resolve({ status: 'active' }) },
      },
      funnel: {
        record: (events: readonly FunnelEvent[]) => {
          recorded.push(...events);
          return Promise.resolve();
        },
      },
    } as unknown as Pick<Database, 'repositories' | 'funnel'>;
    const { logger, records } = createCapturingLogger('api');
    const tracker = createSiteTracker({ database, logger, now: () => clock, maxPerMinute: 2 });
    const target = {
      experimentId: experimentIdSchema.parse('0192f4c2-1111-7000-8000-000000000001'),
      hypothesisId: hypothesisIdSchema.parse('0192f4c2-1111-7000-8000-000000000002'),
      channel: 'Reddit ads',
    };
    const visit = { ...browser, query: { utm_source: 'reddit' } };
    expect(await tracker.track(target, 'attention', visit)).toBe('recorded');
    expect(await tracker.track(target, 'attention', visit)).toBe('repeat');
    expect(await tracker.track(target, 'cta_click', visit)).toBe('recorded');
    expect(await tracker.track(target, 'attention', { ...visit, address: '198.51.100.4' })).toBe(
      'rate_limited',
    );
    clock += 30 * 60_000;
    expect(await tracker.track(target, 'attention', visit)).toBe('recorded');
    expect(recorded.map((event) => [event.stage, event.source, event.utm])).toEqual([
      ['attention', 'tracker', { source: 'reddit' }],
      ['cta_click', 'tracker', { source: 'reddit' }],
      ['attention', 'tracker', { source: 'reddit' }],
    ]);
    expect(
      records.filter((record) => record['message'] === 'page events over the limit of the minute'),
    ).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('203.0.113.9');
  });
});

describe('the landing routes of the api (PHASE 21)', () => {
  const calls: unknown[] = [];
  const router = createRouter({
    health: createHealthRegistry({ service: 'api' }),
    site: {
      preview: () => Promise.resolve({ status: 404 }),
      privacy: () => ({ status: 404 }),
      landing: (slug, step, visit) => {
        calls.push({ slug, step, address: visit.address, query: visit.query });
        return Promise.resolve(
          step === 'go'
            ? { status: 303, redirect: `/l/${slug}/thanks` }
            : { status: 200, html: 'x' },
        );
      },
    },
  });

  it('routes the page, the button and the next step; other methods get 405', async () => {
    await expect(router({ method: 'GET', path: '/l/some-page' })).resolves.toMatchObject({
      status: 200,
      html: 'x',
    });
    await expect(router({ method: 'GET', path: '/l/some-page/go' })).resolves.toMatchObject({
      status: 303,
      redirect: '/l/some-page/thanks',
    });
    await expect(router({ method: 'POST', path: '/l/some-page' })).resolves.toMatchObject({
      status: 405,
    });
    await expect(router({ method: 'GET', path: '/l/some-page/other' })).resolves.toMatchObject({
      status: 404,
    });
    expect(calls.map((call) => (call as { step: string }).step)).toEqual(['page', 'go']);
  });

  it('takes the client address the proxy appended last and keeps preview tokens out of logs', () => {
    expect(
      visitOf({
        method: 'GET',
        path: '/l/x',
        headers: { forwardedFor: '10.0.0.1, 203.0.113.5' },
        remoteAddress: '127.0.0.1',
      }).address,
    ).toBe('203.0.113.5');
    expect(visitOf({ method: 'GET', path: '/l/x', remoteAddress: '127.0.0.1' }).address).toBe(
      '127.0.0.1',
    );
    expect(loggedPath('/p/AbCdEfGhIjKlMnOpQrStUv')).toBe('/p/:token');
    expect(loggedPath('/l/some-page')).toBe('/l/some-page');
  });
});
