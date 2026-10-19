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
  /** Base URL of the HN Search API (Algolia) fake: `/api/v1/search`. */
  readonly searchUrl: string;
  /** The `query` of every search, in order. */
  readonly searches: readonly string[];
  /** Replaces the Ask HN list (ids in ranking order) and adds the items. */
  publish(items: readonly FakeItem[], askIds?: readonly number[]): void;
  /** Ids of the Ask HN stories a search returns, by its words; default: none. */
  answerSearch(answer: (query: string) => readonly number[]): void;
  /** The next responses fail with this HTTP status; `undefined` restores normal answers. */
  failWith(status: number | undefined): void;
  close(): Promise<void>;
}

/**
 * Minimal Hacker News API: `/askstories.json` and `/item/<id>.json` (unknown items are `null`),
 * and HN Search: `/api/v1/search?query=…&tags=ask_hn` with hits as Algolia returns them,
 * including the author, which the connector must not keep.
 */
export async function startFakeHackerNews(): Promise<FakeHackerNews> {
  const requests: string[] = [];
  const bodies: string[] = [];
  const items = new Map<number, FakeItem>();
  let askIds: number[] = [];
  let failure: number | undefined;
  const searches: string[] = [];
  let search: (query: string) => readonly number[] = () => [];

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
    const url = new URL(path, 'http://fake');
    if (url.pathname === '/api/v1/search') {
      const query = url.searchParams.get('query') ?? '';
      searches.push(query);
      const hits = search(query).flatMap((id) => {
        const item = items.get(id);
        if (item === undefined) return [];
        return [
          {
            objectID: String(item.id),
            title: item.title ?? null,
            story_text: item.text ?? null,
            author: item.by ?? null,
            created_at_i: item.time,
            points: item.score ?? 0,
            _tags: ['story', 'ask_hn', `author_${item.by ?? ''}`],
          },
        ];
      });
      respond(res, 200, { hits, nbHits: hits.length, page: 0, hitsPerPage: 30, query });
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
    searchUrl: `http://127.0.0.1:${String(port)}/api/v1`,
    requests,
    bodies,
    searches,
    answerSearch(answer) {
      search = answer;
    },
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
