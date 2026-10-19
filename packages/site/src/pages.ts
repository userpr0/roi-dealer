import {
  captureLead,
  LEAD_FORM_FIELDS,
  CONSENT_VALUE,
  MAX_EMAIL_LENGTH,
  parseLeadForm,
} from '@roi-dealer/crm';
import type { Database } from '@roi-dealer/database';
import {
  LEAD_RETENTION_DAYS,
  MEDIA_SLUG_PATTERN,
  PREVIEW_TOKEN_PATTERN,
  RELEASABLE_EXPERIMENT_STATUSES,
  toTimestamp,
  type LandingDisclosure,
  type MediaAsset,
} from '@roi-dealer/domain';
import { escapeHtml, renderLanding } from '@roi-dealer/media';
import { checkoutLink } from '@roi-dealer/payments';
import type { Logger } from '@roi-dealer/observability';
import type { SubmissionLimiter } from './limits.js';
import {
  SITE_TRACKER,
  utmOf,
  type PageStage,
  type SiteTracker,
  type SiteVisit,
} from './tracker.js';

/*
 * Public pages of experiments (PHASE 19a, 21, 20): framework-free handlers the api maps to its
 * routes. A page is static HTML built by code; the api adds the security headers (CSP without
 * scripts). The only form is the sign-up of a running test.
 */

/** An HTML page or a redirect, as the api sends it. */
export interface SitePage {
  readonly status: number;
  readonly html?: string | undefined;
  /** A same-site or checkout address for a 303 redirect (PHASE 21, 20b). */
  readonly redirect?: string | undefined;
}

const PAGE_STYLE =
  ':root{color-scheme:light dark}body{margin:0;font:16px/1.55 system-ui,sans-serif}' +
  'main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem}' +
  'label{display:block;margin:1rem 0}input[type=email]{display:block;width:100%;box-sizing:border-box;' +
  'font:inherit;padding:.6rem;margin-top:.35rem;border:1px solid #8a8f98;border-radius:.5rem}' +
  'button{font:inherit;font-weight:600;padding:.7rem 1.2rem;border:0;border-radius:.6rem;' +
  'background:#1f6feb;color:#fff;cursor:pointer}.hp{position:absolute;left:-10000px}' +
  '.error{color:#b42318;font-weight:600}.muted{color:#6b7280;font-size:.9rem}a{color:inherit}';

/** A plain page of paragraphs (and trusted HTML built by code), in the style of the landings. */
function documentPage(status: number, title: string, body: readonly string[]): SitePage {
  return {
    status,
    html: [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="robots" content="noindex, nofollow">',
      '<meta name="referrer" content="no-referrer">',
      `<title>${escapeHtml(title)}</title>`,
      `<style>${PAGE_STYLE}</style>`,
      '</head>',
      '<body><main>',
      `<h1>${escapeHtml(title)}</h1>`,
      ...body,
      '</main></body>',
      '</html>',
    ].join('\n'),
  };
}

const paragraph = (text: string): string => `<p>${escapeHtml(text)}</p>`;

/** A plain page for errors and notices, in the style of the landings. */
export function noticePage(status: number, title: string, text: string): SitePage {
  return documentPage(status, title, [paragraph(text)]);
}

export const NOT_FOUND = noticePage(404, 'Not found', 'This page does not exist.');

/** The preview's note to the owner when the api has no contact address (PHASE 20). */
export const NO_FORM_NOTE =
  'Форма заявки выключена: задайте PUBLIC_CONTACT_EMAIL в сервисе api — кнопка ведёт на «спасибо».';

/**
 * The private preview of a landing (PHASE 19a): anyone with the unguessable link sees the
 * draft as it will look, with a banner and an inactive button. Rejected and retired pages are
 * gone.
 */
export async function previewPage(
  database: Pick<Database, 'repositories'>,
  token: string,
  options: { readonly contactEmail?: string | undefined } = {},
): Promise<SitePage> {
  if (!PREVIEW_TOKEN_PATTERN.test(token)) return NOT_FOUND;
  const asset = await database.repositories.mediaAssets.getByPreviewToken(token);
  if (asset === undefined || asset.status === 'rejected' || asset.status === 'retired') {
    return NOT_FOUND;
  }
  return {
    status: 200,
    html: renderLanding(asset.content, {
      mode: 'preview',
      previewNote: options.contactEmail === undefined ? NO_FORM_NOTE : undefined,
    }),
  };
}

/**
 * The privacy notice (PHASE 20): what the pages collect, why, for how long and how to have it
 * deleted. Absent until the api has a contact address.
 */
export function privacyPage(contactEmail: string | undefined): SitePage {
  if (contactEmail === undefined) return NOT_FOUND;
  return documentPage(200, 'Privacy', [
    paragraph(
      'Our test pages count visits and button presses. This count has no personal data: we do ' +
        'not use cookies and do not store your IP address or browser.',
    ),
    paragraph(
      'If you join a waitlist, we store your email address, the time you gave consent and which ' +
        'page you used. We use your email only to tell you about that product. We do not sell ' +
        'or share it, except with our hosting provider, which stores it for us.',
    ),
    paragraph(
      `We delete your email ${String(LEAD_RETENTION_DAYS)} days after the test ends, unless you ` +
        'become a customer. You can ask us to delete it at any time, and to see what we hold ' +
        `about you: write to ${contactEmail}.`,
    ),
  ]);
}

/** The steps of a public landing: the page, the button's redirect, the sign-up, the next step. */
export const LANDING_STEPS = ['page', 'go', 'join', 'joined', 'thanks'] as const;
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

const PAUSED = noticePage(503, 'Sign-ups are paused', 'Please try again later.');
const TOO_MANY = noticePage(429, 'Too many attempts', 'Please try again in an hour.');
const FAILED = noticePage(500, 'Something went wrong', 'Please try again later.');

/** The public path of a landing (PHASE 21). */
export function landingPath(asset: Pick<MediaAsset, 'slug'>, step: LandingStep = 'page'): string {
  return step === 'page' ? `/l/${asset.slug}` : `/l/${asset.slug}/${step}`;
}

/** The query string of the visit's UTM tags, carried to the next step's address. */
function utmQuery(visit: SiteVisit): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(utmOf(visit.query))) params.set(`utm_${key}`, value);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** The sign-up form: an email, the consent box and a trap field hidden from people. */
function joinPage(
  asset: MediaAsset,
  visit: SiteVisit,
  status: number,
  error?: 'email' | 'consent',
): SitePage {
  const e = escapeHtml;
  const action = `${landingPath(asset, 'join')}${utmQuery(visit)}`;
  return documentPage(status, asset.content.headline, [
    paragraph(asset.content.offer),
    error === 'email' ? '<p class="error">Please enter a valid email address.</p>' : '',
    error === 'consent' ? '<p class="error">Please tick the box to agree.</p>' : '',
    `<form method="post" action="${e(action)}">`,
    `<label>Email<input type="email" name="${LEAD_FORM_FIELDS.email}" required maxlength="${String(MAX_EMAIL_LENGTH)}" autocomplete="email"></label>`,
    `<div class="hp" aria-hidden="true"><label>Website<input name="${LEAD_FORM_FIELDS.trap}" tabindex="-1" autocomplete="off"></label></div>`,
    `<label><input type="checkbox" name="${LEAD_FORM_FIELDS.consent}" value="${CONSENT_VALUE}" required> ` +
      'Email me about this product. I can ask you to delete my email at any time. ' +
      '<a href="/privacy">Privacy</a></label>',
    `<button type="submit">${e(asset.content.cta)}</button>`,
    '</form>',
    `<p class="muted">${e(MEASUREMENT_NOTE)}</p>`,
  ]);
}

export interface LandingRouteDeps {
  readonly database: Pick<Database, 'repositories' | 'transaction'>;
  readonly tracker: SiteTracker;
  readonly logger: Logger;
  /** Where people ask to delete their data (`PUBLIC_CONTACT_EMAIL`); without it no form. */
  readonly contactEmail?: string | undefined;
  readonly limiter: SubmissionLimiter;
  readonly now?: () => number;
}

/**
 * A released landing (PHASE 21): public while its experiment's launch is approved or the test
 * runs; the funnel counts views, presses and sign-ups only while it runs. After the test the
 * page says so (410); a page that was not released does not exist (404). `form` is the body of
 * a sign-up (POST to the `join` step, PHASE 20).
 */
export async function landingPage(
  deps: LandingRouteDeps,
  slug: string,
  step: LandingStep,
  visit: SiteVisit,
  form?: string,
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
  const running = experiment.status === 'running';
  const hypothesisOf = () => repositories.hypotheses.getById(experiment.hypothesisId);
  const track = async (stage: PageStage): Promise<void> => {
    if (!running) return;
    const hypothesis = await hypothesisOf();
    if (hypothesis === undefined) return;
    await deps.tracker.track(
      { experimentId: experiment.id, hypothesisId: hypothesis.id, channel: hypothesis.channel },
      stage,
      visit,
    );
  };
  const formEnabled = deps.contactEmail !== undefined;
  const thanks = (): SitePage => {
    const words = THANKS[asset.content.disclosure];
    return noticePage(200, words.title, words.text);
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
          privacyHref: formEnabled ? '/privacy' : undefined,
        }),
      };
    }
    case 'go': {
      await track('cta_click');
      // A preorder pays at the merchant of record (PHASE 20b, ADR-0009).
      if (asset.content.disclosure === 'preorder') {
        const [checkout] = await repositories.checkouts.listActiveByExperiments([experiment.id]);
        if (checkout !== undefined) {
          return {
            status: 303,
            redirect: checkoutLink(checkout.url, {
              experimentId: experiment.id,
              utmSource: utmOf(visit.query)['source'],
            }),
          };
        }
      }
      return {
        status: 303,
        redirect: formEnabled
          ? `${landingPath(asset, 'join')}${utmQuery(visit)}`
          : landingPath(asset, 'thanks'),
      };
    }
    case 'join': {
      if (!formEnabled) return { status: 303, redirect: landingPath(asset, 'thanks') };
      if (form === undefined) return joinPage(asset, visit, 200);
      const parsed = parseLeadForm(form);
      // A robot gets the same answer as a person and nothing is stored.
      if (parsed.kind === 'trap') return { status: 303, redirect: landingPath(asset, 'joined') };
      if (parsed.kind === 'invalid') return joinPage(asset, visit, 400, parsed.reason);
      // Before the start (the crash test) nothing is stored.
      if (!running) return { status: 303, redirect: landingPath(asset, 'thanks') };
      if (!deps.limiter.allow(visit.address)) return TOO_MANY;
      if ((await deps.tracker.writable()) !== 'ok') return PAUSED;
      const hypothesis = await hypothesisOf();
      if (hypothesis === undefined) return FAILED;
      try {
        await captureLead(
          deps.database,
          {
            asset,
            experiment,
            hypothesis,
            email: parsed.email,
            utm: utmOf(visit.query),
            at: toTimestamp(new Date((deps.now ?? Date.now)())),
            correlationId: visit.correlationId,
          },
          SITE_TRACKER,
        );
      } catch (error) {
        // No form data in the log.
        deps.logger.error('sign-up not recorded', { error });
        return FAILED;
      }
      return { status: 303, redirect: landingPath(asset, 'joined') };
    }
    case 'joined':
      return formEnabled
        ? noticePage(
            200,
            'You are on the list!',
            'We will email you about this product. To delete your email at any time, write to ' +
              `${deps.contactEmail ?? ''}.`,
          )
        : thanks();
    case 'thanks':
      return thanks();
  }
}
