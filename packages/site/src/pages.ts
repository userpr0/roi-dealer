import type { Database } from '@roi-dealer/database';
import { PREVIEW_TOKEN_PATTERN } from '@roi-dealer/domain';
import { escapeHtml, renderLanding } from '@roi-dealer/media';

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
