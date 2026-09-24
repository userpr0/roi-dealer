import type { HealthRegistry } from '@roi-dealer/observability';

export interface ApiRequest {
  readonly method: string;
  /** URL path without query string. */
  readonly path: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RouterDeps {
  readonly health: HealthRegistry;
}

export type Router = (request: ApiRequest) => Promise<ApiResponse>;

/**
 * Transport-independent request routing. PHASE 00 exposes only `GET /health`.
 * Kept free of `node:http` so routes can be unit-tested without sockets.
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
    return { status: 404, body: { error: 'not_found' } };
  };
}
