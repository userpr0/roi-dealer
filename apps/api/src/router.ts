import type { HealthRegistry } from '@roi-dealer/observability';

export interface ApiRequest {
  readonly method: string;
  /** URL path without query string. */
  readonly path: string;
  /** Only the headers routes read: `origin` and `authorization` (PHASE 13). */
  readonly headers?: Readonly<{ origin?: string | undefined; authorization?: string | undefined }>;
  readonly correlationId?: string | undefined;
}

export interface ApiResponse {
  readonly status: number;
  /** `undefined` sends no body (204). */
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The Mini App's data (PHASE 13, ADR-0008): allowed origins and the authorized read. */
export interface PanelRoute {
  readonly origins: readonly string[];
  read(authorization: string | undefined, correlationId: string | undefined): Promise<ApiResponse>;
}

export interface RouterDeps {
  readonly health: HealthRegistry;
  /** Absent until the database and the bot token are configured: `/api/panel` answers 503. */
  readonly panel?: PanelRoute | undefined;
}

export type Router = (request: ApiRequest) => Promise<ApiResponse>;

export const PANEL_PATH = '/api/panel';

/**
 * Transport-independent request routing: `GET /health` (PHASE 00) and `GET /api/panel` for the
 * Mini App (PHASE 13). Kept free of `node:http` so routes can be unit-tested without sockets.
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
