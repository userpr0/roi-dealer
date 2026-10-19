import { randomBytes } from 'node:crypto';
import { MEDIA_SLUG_PATTERN, type LandingContent } from '@roi-dealer/domain';
import { disclosureText, priceLabel } from './landing.js';

/*
 * The landing template (PHASE 19a, used for the preview and, from PHASE 21, the public page):
 * static HTML with inline styles — no scripts, no external fonts, images or trackers — and
 * every text escaped. The server adds a strict Content-Security-Policy.
 */

export interface LandingPageOptions {
  /** `preview` shows a banner and an inactive button; `public` links the button. */
  readonly mode: 'preview' | 'public';
  /** Where the button leads on the public page (the tracked redirect, PHASE 21). */
  readonly ctaHref?: string | undefined;
  /** The page's footer link to the privacy notice (PHASE 20). */
  readonly privacyHref?: string | undefined;
  /** HTML of a block after the offer (the email form, PHASE 20); trusted, built by code. */
  readonly afterOffer?: string | undefined;
  /** A line of the footer, e.g. what the page measures (PHASE 21). */
  readonly footerNote?: string | undefined;
  /** A second line of the preview banner for the owner (PHASE 20). */
  readonly previewNote?: string | undefined;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#14161a;--muted:#5b616b;--card:#f4f5f7;--accent:#1f6feb;--accent-fg:#ffffff;--line:#e3e5e8}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--fg:#eceef1;--muted:#a2a8b2;--card:#1b1e23;--accent:#4c8dff;--accent-fg:#0b0d10;--line:#2a2e35}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.banner{background:#fff4ce;color:#3b2f00;padding:.6rem 1rem;text-align:center;font-size:.9rem}
h1{font-size:2rem;line-height:1.2;margin:0 0 .75rem}
h2{font-size:1.25rem;margin:2.25rem 0 .75rem}
.sub{font-size:1.15rem;color:var(--muted);margin:0 0 1.5rem}
.problem{background:var(--card);border-radius:.75rem;padding:1rem 1.25rem}
.grid{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))}
.card{background:var(--card);border-radius:.75rem;padding:1rem}
.card h3{margin:0 0 .35rem;font-size:1rem}
.card p{margin:0;color:var(--muted)}
ol{padding-left:1.25rem}
li{margin:.35rem 0}
.offer{border:1px solid var(--line);border-radius:.75rem;padding:1.25rem;margin-top:2.25rem}
.price{font-size:1.5rem;font-weight:700;margin:.25rem 0 .75rem}
.cta{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;padding:.75rem 1.25rem;border-radius:.6rem}
.cta[aria-disabled=true]{opacity:.6;cursor:not-allowed}
.note{color:var(--muted);font-size:.9rem;margin-top:.9rem}
details{border-top:1px solid var(--line);padding:.75rem 0}
summary{cursor:pointer;font-weight:600}
footer{margin-top:3rem;color:var(--muted);font-size:.85rem}
footer a{color:inherit}
`;

/** The page of a landing as static HTML. */
export function renderLanding(content: LandingContent, options: LandingPageOptions): string {
  const e = escapeHtml;
  const preview = options.mode === 'preview';
  const button =
    preview || options.ctaHref === undefined
      ? `<a class="cta" aria-disabled="true">${e(content.cta)}</a>`
      : `<a class="cta" href="${e(options.ctaHref)}">${e(content.cta)}</a>`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${e(content.headline)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    preview ? '<div class="banner">Preview — this page is not public yet.</div>' : '',
    preview && options.previewNote !== undefined
      ? `<div class="banner">${e(options.previewNote)}</div>`
      : '',
    '<main>',
    `<h1>${e(content.headline)}</h1>`,
    `<p class="sub">${e(content.subheadline)}</p>`,
    `<p class="problem">${e(content.problem)}</p>`,
    '<h2>What changes</h2>',
    '<div class="grid">',
    ...content.benefits.map(
      (item) => `<div class="card"><h3>${e(item.title)}</h3><p>${e(item.text)}</p></div>`,
    ),
    '</div>',
    '<h2>How it works</h2>',
    '<ol>',
    ...content.steps.map((step) => `<li>${e(step)}</li>`),
    '</ol>',
    '<section class="offer" id="offer">',
    `<p>${e(content.offer)}</p>`,
    `<p class="price">${e(priceLabel(content.price, content.pricePeriod))}</p>`,
    button,
    `<p class="note">${e(disclosureText(content.disclosure))}</p>`,
    options.afterOffer ?? '',
    '</section>',
    '<h2>Questions</h2>',
    ...content.faq.map(
      (item) => `<details><summary>${e(item.question)}</summary><p>${e(item.answer)}</p></details>`,
    ),
    '<footer>',
    options.footerNote === undefined ? '' : `<p>${e(options.footerNote)}</p>`,
    options.privacyHref === undefined ? '' : `<a href="${e(options.privacyHref)}">Privacy</a>`,
    '</footer>',
    '</main>',
    '</body>',
    '</html>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Whether a rendered page is static (Release Gate, PHASE 21): no scripts, frames, embedded or
 * linked resources and no external addresses — nothing runs or loads on the visitor's side.
 */
export function isStaticPage(html: string): boolean {
  return !/<(?:script|iframe|object|embed|link|img)\b|\son[a-z]+\s*=|\bsrc\s*=|https?:\/\/|javascript:/i.test(
    html,
  );
}

/** The public path segment of a landing: words of the title and part of its id. */
export function landingSlug(title: string, id: string): string {
  const words = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const suffix = id
    .replace(/[^a-f0-9]/gi, '')
    .slice(-8)
    .toLowerCase();
  const slug = words === '' ? `landing-${suffix}` : `${words}-${suffix}`;
  if (!MEDIA_SLUG_PATTERN.test(slug)) throw new Error('slug does not match the pattern');
  return slug;
}

/** An unguessable token (128 bits) for the private preview link. */
export function newPreviewToken(): string {
  return randomBytes(16).toString('base64url');
}
