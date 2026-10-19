import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
  type Logger,
} from '@roi-dealer/observability';
import { loggedPath, type ApiResponse, type Router } from './router.js';

export interface ApiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly router: Router;
  readonly logger: Logger;
}

export interface ApiServer {
  /** Actual bound port (differs from the requested one when it was 0). */
  readonly port: number;
  /** Stops accepting connections and waits for in-flight requests to finish. */
  close(): Promise<void>;
}

/**
 * Pages are static HTML built by code (PHASE 19a): no scripts, frames or external resources;
 * forms post only to this site.
 */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const MAX_QUERY_PARAMS = 20;
/** The longest body read: a sign-up form (PHASE 20). */
const MAX_BODY_BYTES = 4_096;
const TOO_LARGE = Symbol('too large');

/** The body of a form POST, or `TOO_LARGE` beyond `MAX_BODY_BYTES`; never logged. */
async function readForm(req: IncomingMessage): Promise<string | typeof TOO_LARGE> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > MAX_BODY_BYTES) return TOO_LARGE;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return TOO_LARGE;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const MAX_HEADER_LENGTH = 1_000;

/** The first value of each query parameter, bounded. */
function queryOf(url: URL): Record<string, string> {
  // No prototype: a parameter named like an Object property is just a key.
  const query = Object.create(null) as Record<string, string>;
  let count = 0;
  for (const [key, value] of url.searchParams) {
    if (count >= MAX_QUERY_PARAMS) break;
    if (Object.hasOwn(query, key) || key.length > 50) continue;
    query[key] = value.slice(0, 200);
    count += 1;
  }
  return query;
}

/** A single header value, bounded; repeated headers are joined by Node. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value.join(', ') : value;
  return text === undefined ? undefined : text.slice(0, MAX_HEADER_LENGTH);
}

function send(
  res: ServerResponse,
  method: string | undefined,
  response: ApiResponse,
  correlationId: string,
): void {
  if (response.redirect !== undefined) {
    res.writeHead(response.status, {
      ...response.headers,
      ...PAGE_SECURITY_HEADERS,
      location: response.redirect,
      'cache-control': 'no-store',
      [CORRELATION_ID_HEADER]: correlationId,
    });
    res.end();
    return;
  }
  if (response.html !== undefined) {
    res.writeHead(response.status, {
      ...response.headers,
      ...PAGE_SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(response.html),
      'cache-control': 'no-store',
      [CORRELATION_ID_HEADER]: correlationId,
    });
    res.end(method === 'HEAD' ? undefined : response.html);
    return;
  }
  if (response.body === undefined) {
    res.writeHead(response.status, {
      ...response.headers,
      'cache-control': 'no-store',
      [CORRELATION_ID_HEADER]: correlationId,
    });
    res.end();
    return;
  }
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    ...response.headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    [CORRELATION_ID_HEADER]: correlationId,
  });
  res.end(method === 'HEAD' ? undefined : payload);
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { router, logger } = options;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startedAt = performance.now();
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
    const requestLogger = logger.child({ correlation_id: correlationId });
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    let response: ApiResponse;
    try {
      const body = method === 'POST' ? await readForm(req) : undefined;
      if (body === TOO_LARGE) {
        send(res, method, { status: 413, body: { error: 'payload_too_large' } }, correlationId);
        req.resume();
        requestLogger.info('request completed', { method, path: loggedPath(path), status: 413 });
        return;
      }
      response = await router({
        body,
        method,
        path,
        query: queryOf(url),
        // Only what routes read; headers, the query and addresses are never logged.
        headers: {
          origin: req.headers.origin,
          authorization: req.headers.authorization,
          userAgent: header(req, 'user-agent'),
          purpose: header(req, 'sec-purpose') ?? header(req, 'purpose'),
          forwardedFor: header(req, 'x-forwarded-for'),
        },
        remoteAddress: req.socket.remoteAddress,
        correlationId,
      });
    } catch (error) {
      requestLogger.error('request handler failed', { method, path: loggedPath(path), error });
      response = { status: 500, body: { error: 'internal_error' } };
    }

    send(res, method, response, correlationId);
    requestLogger.info('request completed', {
      method,
      path: loggedPath(path),
      status: response.status,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  logger.info('api listening', { host: options.host, port });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
