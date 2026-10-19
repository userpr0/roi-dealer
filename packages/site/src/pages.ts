import type { Database } from '@roi-dealer/database';
import {
  MEDIA_SLUG_PATTERN,
  PREVIEW_TOKEN_PATTERN,
  RELEASABLE_EXPERIMENT_STATUSES,
  type LandingDisclosure,
  type MediaAsset,
} from '@roi-dealer/domain';
import { escapeHtml, renderLanding } from '@roi-dealer/media';
import { utmOf, type SiteTracker, type SiteVisit, type TrackedStage } from './tracker.js';

/*
 * Public pages of experiments (PHASE 19a): framework-free handlers the api maps to its routes.
 * A page is static HTML built by code; the api adds the security headers (CSP without scripts).
 */

/** An HTML page or a redirect, as the api sends it. */
export interface SitePage {
  readonly status: number;
  readonly html?: string | undefined;
  /** A same-site or checkout address for a 303 redirect (PHASE 21, 20b). */
  readonly redirect?: string | undefined;
}

/** A plain page for errors and notices, in the style of the landings. */
export function noticePage(status: number, title: string, text: string): SitePage {
  const e = escapeHtml;
  return {
    status,
    html: [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="robots" content="noindex, nofollow">',
      `<title>${e(title)}</title>`,
      '<style>:root{color-scheme:light dark}body{margin:0;font:16px/1.55 system-ui,sans-serif}main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem}</style>',
      '</head>',
      '<body><main>',
      `<h1>${e(title)}</h1>`,
      `<p>${e(text)}</p>`,
      '</main></body>',
      '</html>',
    ].join('\n'),
  };
}

export const NOT_FOUND = noticePage(404, 'Not found', 'This page does not exist.');

/**
 * The private preview of a landing (PHASE 19a): anyone with the unguessable link sees the
 * draft as it will look, with a banner and an inactive button. Rejected and retired pages are
 * gone.
 */
export async function previewPage(
  database: Pick<Database, 'repositories'>,
  token: string,
): Promise<SitePage> {
  if (!PREVIEW_TOKEN_PATTERN.test(token)) return NOT_FOUND;
  const asset = await database.repositories.mediaAssets.getByPreviewToken(token);
  if (asset === undefined || asset.status === 'rejected' || asset.status === 'retired') {
    return NOT_FOUND;
  }
  return { status: 200, html: renderLanding(asset.content, { mode: 'preview' }) };
}

/** The steps of a public landing (PHASE 21): the page, the button's redirect, the next step. */
export const LANDING_STEPS = ['page', 'go', 'thanks'] as const;
export type LandingStep = (typeof LANDING_STEPS)[number];

/** What the page tells visitors it measures (PHASE 21). */
export const MEASUREMENT_NOTE =
  'No cookies. This page counts visits and button presses without any personal data.';

export const ENDED = noticePage(
  410,
  'This test has ended',
  'Thank you for your interest. This early-access page is closed.',
);

const THANKS: Readonly<Record<LandingDisclosure, { title: string; text: string }>> = {
  in_development: {
    title: 'Thank you!',
    text:
      'The product is not available yet: we are measuring interest before we build it. ' +
      'Your click tells us this matters. Nothing was collected from you.',
  },
  preorder: {
    title: 'Thank you!',
    text:
      'Preorders are not open yet. Your click tells us this matters. Nothing was collected ' +
      'from you and nothing was charged.',
  },
};

/** The public path of a landing (PHASE 21). */
export function landingPath(asset: Pick<MediaAsset, 'slug'>, step: LandingStep = 'page'): string {
  return step === 'page' ? `/l/${asset.slug}` : `/l/${asset.slug}/${step}`;
}

/** The query string of the visit's UTM tags, carried to the button's address. */
function utmQuery(visit: SiteVisit): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(utmOf(visit.query))) params.set(`utm_${key}`, value);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export interface LandingRouteDeps {
  readonly database: Pick<Database, 'repositories'>;
  readonly tracker: SiteTracker;
}

/**
 * A released landing (PHASE 21): public while its experiment's launch is approved or the test
 * runs; the funnel counts views and presses only while it runs. After the test the page says
 * so (410); a page that was not released does not exist (404).
 */
export async function landingPage(
  deps: LandingRouteDeps,
  slug: string,
  step: LandingStep,
  visit: SiteVisit,
): Promise<SitePage> {
  if (!MEDIA_SLUG_PATTERN.test(slug)) return NOT_FOUND;
  const { repositories } = deps.database;
  const asset = await repositories.mediaAssets.getBySlug(slug);
  if (asset === undefined || asset.releasedAt === undefined) return NOT_FOUND;
  if (asset.status !== 'released') return ENDED;
  const experiment = await repositories.experiments.getById(asset.experimentId);
  if (
    experiment === undefined ||
    !(RELEASABLE_EXPERIMENT_STATUSES as readonly string[]).includes(experiment.status)
  ) {
    return ENDED;
  }
  const track = async (stage: TrackedStage): Promise<void> => {
    if (experiment.status !== 'running') return;
    const hypothesis = await repositories.hypotheses.getById(experiment.hypothesisId);
    if (hypothesis === undefined) return;
    await deps.tracker.track(
      { experimentId: experiment.id, hypothesisId: hypothesis.id, channel: hypothesis.channel },
      stage,
      visit,
    );
  };
  switch (step) {
    case 'page': {
      await track('attention');
      return {
        status: 200,
        html: renderLanding(asset.content, {
          mode: 'public',
          ctaHref: `${landingPath(asset, 'go')}${utmQuery(visit)}`,
          footerNote: MEASUREMENT_NOTE,
        }),
      };
    }
    case 'go':
      await track('cta_click');
      return { status: 303, redirect: landingPath(asset, 'thanks') };
    case 'thanks': {
      const thanks = THANKS[asset.content.disclosure];
      return noticePage(200, thanks.title, thanks.text);
    }
  }
}
