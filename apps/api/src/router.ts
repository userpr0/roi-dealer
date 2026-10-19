import type { HealthRegistry } from '@roi-dealer/observability';
import type { LandingStep, SiteVisit } from '@roi-dealer/site';

export interface ApiRequest {
  readonly method: string;
  /** URL path without query string. */
  readonly path: string;
  /** Query parameters, the first value of each (PHASE 21: UTM tags of landings). */
  readonly query?: Readonly<Record<string, string>> | undefined;
  /**
   * Only the headers routes read: `origin` and `authorization` (PHASE 13); the browser, the
   * purpose of the request and the proxy's client address for the page counter (PHASE 21).
   */
  readonly headers?: Readonly<{
    origin?: string | undefined;
    authorization?: string | undefined;
    userAgent?: string | undefined;
    purpose?: string | undefined;
    forwardedFor?: string | undefined;
  }>;
  /** The socket's peer address, when no proxy forwarded the client's. */
  readonly remoteAddress?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface ApiResponse {
  readonly status: number;
  /** `undefined` sends no body (204). */
  readonly body: unknown;
  /** A page instead of JSON (PHASE 19a): sent with a CSP that allows no scripts. */
  readonly html?: string | undefined;
  /** A same-site address for a 303 redirect (PHASE 21). */
  readonly redirect?: string | undefined;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The Mini App's data (PHASE 13, ADR-0008): allowed origins and the authorized read. */
export interface PanelRoute {
  readonly origins: readonly string[];
  read(authorization: string | undefined, correlationId: string | undefined): Promise<ApiResponse>;
}

/** A page of the site: HTML or a redirect. */
export interface SiteResponse {
  readonly status: number;
  readonly html?: string | undefined;
  readonly redirect?: string | undefined;
}

/** Public pages of experiments (PHASE 19a, 21): present when the database is configured. */
export interface SiteRoutes {
  /** The private preview of a landing by its token. */
  preview(token: string): Promise<SiteResponse>;
  /** A released landing, its button and the next step (PHASE 21). */
  landing(slug: string, step: LandingStep, visit: SiteVisit): Promise<SiteResponse>;
}

export interface RouterDeps {
  readonly health: HealthRegistry;
  /** Absent until the database and the bot token are configured: `/api/panel` answers 503. */
  readonly panel?: PanelRoute | undefined;
  readonly site?: SiteRoutes | undefined;
}

export type Router = (request: ApiRequest) => Promise<ApiResponse>;

export const PANEL_PATH = '/api/panel';
const PREVIEW_PATH = /^\/p\/([^/]{1,100})$/;
const LANDING_PATH = /^\/l\/([^/]{1,100})(?:\/(go|thanks))?$/;

const PAGE_METHOD_NOT_ALLOWED: ApiResponse = {
  status: 405,
  body: { error: 'method_not_allowed' },
  headers: { allow: 'GET, HEAD' },
};

/** The path as logged: a private preview's token stays out of the logs. */
export function loggedPath(path: string): string {
  return PREVIEW_PATH.test(path) ? '/p/:token' : path;
}

/** The client of a page request: the address the proxy appended last, else the socket's. */
export function visitOf(request: ApiRequest): SiteVisit {
  const forwarded = request.headers?.forwardedFor
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return {
    method: request.method,
    query: request.query ?? {},
    userAgent: request.headers?.userAgent,
    address: forwarded?.at(-1) ?? request.remoteAddress,
    purpose: request.headers?.purpose,
    correlationId: request.correlationId,
  };
}

/**
 * Transport-independent request routing: `GET /health` (PHASE 00), `GET /api/panel` for the
 * Mini App (PHASE 13) and the pages of experiments: previews (PHASE 19a) and released landings
 * (PHASE 21). Kept free of `node:http` so routes can be unit-tested without sockets.
 */
export function createRouter(deps: RouterDeps): Router {
  return async (request) => {
    if (request.path === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return {
          status: 405,
          body: { error: 'method_not_allowed' },
          headers: { allow: 'GET, HEAD' },
        };
      }
      const report = await deps.health.run();
      return { status: report.status === 'down' ? 503 : 200, body: report };
    }
    if (request.path === PANEL_PATH) return panel(deps, request);
    const preview = PREVIEW_PATH.exec(request.path);
    if (preview !== null && deps.site !== undefined) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return PAGE_METHOD_NOT_ALLOWED;
      const page = await deps.site.preview(preview[1] ?? '');
      return { status: page.status, body: undefined, html: page.html };
    }
    const landing = LANDING_PATH.exec(request.path);
    if (landing !== null && deps.site !== undefined) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return PAGE_METHOD_NOT_ALLOWED;
      const step = (landing[2] ?? 'page') as LandingStep;
      const page = await deps.site.landing(landing[1] ?? '', step, visitOf(request));
      return { status: page.status, body: undefined, html: page.html, redirect: page.redirect };
    }
    return { status: 404, body: { error: 'not_found' } };
  };
}

async function panel(deps: RouterDeps, request: ApiRequest): Promise<ApiResponse> {
  const origin = request.headers?.origin;
  const allowed = origin !== undefined && (deps.panel?.origins.includes(origin) ?? false);
  // Only the Mini App's own origin may read the response in a browser.
  const cors: Record<string, string> = allowed
    ? { 'access-control-allow-origin': origin, vary: 'origin' }
    : { vary: 'origin' };
  if (request.method === 'OPTIONS') {
    if (!allowed) return { status: 403, body: { error: 'origin_not_allowed' }, headers: cors };
    return {
      status: 204,
      body: undefined,
      headers: {
        ...cors,
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization',
        'access-control-max-age': '600',
      },
    };
  }
  if (request.method !== 'GET') {
    return {
      status: 405,
      body: { error: 'method_not_allowed' },
      headers: { ...cors, allow: 'GET, OPTIONS' },
    };
  }
  if (deps.panel === undefined) {
    return { status: 503, body: { error: 'not_configured' }, headers: cors };
  }
  const response = await deps.panel.read(request.headers?.authorization, request.correlationId);
  return { ...response, headers: { ...response.headers, ...cors } };
}
