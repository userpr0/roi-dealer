import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CORRELATION_ID_HEADER,
  resolveCorrelationId,
  type Logger,
} from '@roi-dealer/observability';
import type { ApiResponse, Router } from './router.js';

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

function send(
  res: ServerResponse,
  method: string | undefined,
  response: ApiResponse,
  correlationId: string,
): void {
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
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    let response: ApiResponse;
    try {
      response = await router({ method, path });
    } catch (error) {
      requestLogger.error('request handler failed', { method, path, error });
      response = { status: 500, body: { error: 'internal_error' } };
    }

    send(res, method, response, correlationId);
    requestLogger.info('request completed', {
      method,
      path,
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
