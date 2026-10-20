import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A post as the Lemmy API (v3) returns it inside a post view, with the fields the connector reads. */
export interface FakeLemmyPost {
  readonly id: number;
  readonly community: string;
  readonly name: string;
  readonly body?: string | null;
  readonly local?: boolean;
  readonly published?: string;
  readonly deleted?: boolean;
  readonly removed?: boolean;
  readonly nsfw?: boolean;
  readonly languageId?: number;
  /** The author's name: returned as Lemmy does, never kept by the connector. */
  readonly creator?: string;
}

export interface FakeLemmy {
  /** Base URL to pass as `LEMMY_API_URL` / `createLemmyConnector({ baseUrl })`. */
  readonly baseUrl: string;
  /** Every requested path with its query, in order. */
  readonly requests: readonly string[];
  /** Raw response bodies, in request order (to check the snapshot hash). */
  readonly bodies: readonly string[];
  /** Adds posts; each community lists its posts newest first. */
  publish(posts: readonly FakeLemmyPost[]): void;
  /** The next responses fail with this HTTP status; `undefined` restores normal answers. */
  failWith(status: number | undefined): void;
  close(): Promise<void>;
}

/** Minimal Lemmy API: `GET /api/v3/post/list?community_name=…&sort=New&limit=…`. */
export async function startFakeLemmy(): Promise<FakeLemmy> {
  const requests: string[] = [];
  const bodies: string[] = [];
  const posts: FakeLemmyPost[] = [];
  let failure: number | undefined;
  let origin = '';

  const respond = (res: ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value);
    if (status === 200) bodies.push(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };

  const view = (post: FakeLemmyPost) => ({
    post: {
      id: post.id,
      name: post.name,
      body: post.body ?? null,
      creator_id: 1_000 + post.id,
      community_id: 1,
      removed: post.removed ?? false,
      locked: false,
      published: post.published ?? new Date().toISOString(),
      deleted: post.deleted ?? false,
      nsfw: post.nsfw ?? false,
      ap_id:
        (post.local ?? true)
          ? `${origin}/post/${String(post.id)}`
          : `https://other.example/post/${String(post.id)}`,
      local: post.local ?? true,
      language_id: post.languageId ?? 37,
    },
    creator: { id: 1_000 + post.id, name: post.creator ?? 'someone', local: true },
    community: { id: 1, name: post.community, local: true },
    counts: { comments: 0, score: 1 },
  });

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = req.url ?? '';
    requests.push(path);
    if (failure !== undefined) {
      respond(res, failure, { error: 'unavailable' });
      return;
    }
    const url = new URL(path, 'http://fake');
    if (url.pathname === '/api/v3/post/list') {
      const community = url.searchParams.get('community_name');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const listed = posts
        .filter((post) => post.community === community)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(view);
      respond(res, 200, { posts: listed });
      return;
    }
    respond(res, 404, { error: 'not found' });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;

  return {
    baseUrl: `${origin}/api/v3`,
    requests,
    bodies,
    publish(published) {
      posts.push(...published);
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
