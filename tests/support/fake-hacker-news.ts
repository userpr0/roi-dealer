import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An item as the official Hacker News API returns it (github.com/HackerNews/API). */
export interface FakeItem {
  readonly id: number;
  readonly type?: string;
  readonly by?: string;
  readonly time?: number;
  readonly title?: string;
  readonly text?: string;
  readonly deleted?: boolean;
  readonly dead?: boolean;
  readonly score?: number;
}

export interface FakeHackerNews {
  /** Base URL to pass as `HACKER_NEWS_API_URL` / `createHackerNewsConnector({ baseUrl })`. */
  readonly baseUrl: string;
  /** Every requested path, in order. */
  readonly requests: readonly string[];
  /** Raw response bodies, in request order (to check the snapshot hash). */
  readonly bodies: readonly string[];
  /** Replaces the Ask HN list (ids in ranking order) and adds the items. */
  publish(items: readonly FakeItem[], askIds?: readonly number[]): void;
  /** The next responses fail with this HTTP status; `undefined` restores normal answers. */
  failWith(status: number | undefined): void;
  close(): Promise<void>;
}

/** Minimal Hacker News API: `/askstories.json` and `/item/<id>.json`; unknown items are `null`. */
export async function startFakeHackerNews(): Promise<FakeHackerNews> {
  const requests: string[] = [];
  const bodies: string[] = [];
  const items = new Map<number, FakeItem>();
  let askIds: number[] = [];
  let failure: number | undefined;

  const respond = (res: ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value);
    if (status === 200) bodies.push(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = req.url ?? '';
    requests.push(path);
    if (failure !== undefined) {
      respond(res, failure, { error: 'unavailable' });
      return;
    }
    if (path === '/v0/askstories.json') {
      respond(res, 200, askIds);
      return;
    }
    const match = /^\/v0\/item\/(\d+)\.json$/.exec(path);
    if (match !== null) {
      respond(res, 200, items.get(Number(match[1])) ?? null);
      return;
    }
    respond(res, 404, { error: 'not found' });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v0`,
    requests,
    bodies,
    publish(published, ids) {
      for (const item of published) items.set(item.id, item);
      askIds = [...(ids ?? published.map((item) => item.id))];
    },
    failWith(status) {
      failure = status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
