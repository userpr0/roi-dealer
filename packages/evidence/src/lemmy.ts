import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toTimestamp } from '@roi-dealer/domain';
import type { CollectedItem, ConnectorRun, FetchRequest, SourceConnector } from './connector.js';
import { EvidenceEngineError } from './errors.js';

/** Official Lemmy API of lemmy.world (legal.lemmy.world/tos): public, read-only, no key. */
export const LEMMY_API_URL = 'https://lemmy.world/api/v3';
export const LEMMY_CATALOG_KEY = 'lemmy-world';
/** Communities on lemmy.world where people ask questions and describe their problems. */
export const LEMMY_COMMUNITIES = ['asklemmy', 'nostupidquestions', 'selfhosted'] as const;
const PAGE_SIZE = 20;
/** Lemmy language ids: 0 — undetermined, 37 — English. */
const LANGUAGE_IDS: ReadonlySet<number> = new Set([0, 37]);
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A post as `GET /post/list` returns it; only the fields we use are read. `creator` (the author)
 * is deliberately absent: it is never read or stored.
 */
const postListSchema = z.object({
  posts: z
    .array(
      z.object({
        post: z.object({
          id: z.int().positive(),
          name: z.string(),
          body: z.string().nullish(),
          ap_id: z.url({ protocol: /^https?$/ }),
          local: z.boolean(),
          published: z.iso.datetime({ offset: true }),
          deleted: z.boolean(),
          removed: z.boolean(),
          nsfw: z.boolean(),
          language_id: z.int(),
        }),
      }),
    )
    .max(50),
});
type LemmyPost = z.infer<typeof postListSchema>['posts'][number]['post'];

export interface LemmyOptions {
  /** Default: lemmy.world; tests point it to a local fake. */
  readonly baseUrl?: string;
  readonly communities?: readonly string[];
  readonly requestTimeoutMs?: number;
}

/**
 * The newest posts of a few lemmy.world communities. Keeps only posts created on lemmy.world —
 * copies from other Lemmy servers fall under those servers' terms (catalog) — in English or
 * without a language, and never deleted, removed or NSFW ones.
 */
export function createLemmyConnector(options: LemmyOptions = {}): SourceConnector {
  const baseUrl = (options.baseUrl ?? LEMMY_API_URL).replace(/\/+$/, '');
  const communities = options.communities ?? LEMMY_COMMUNITIES;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const listUrl = (community: string): string =>
    `${baseUrl}/post/list?${new URLSearchParams({
      community_name: community,
      sort: 'New',
      limit: String(PAGE_SIZE),
    }).toString()}`;

  async function getPosts(
    url: string,
    hash: ReturnType<typeof createHash>,
    signal?: AbortSignal,
  ): Promise<LemmyPost[]> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      throw new EvidenceEngineError('fetch_failed', 'Lemmy is not reachable', {
        catalog_key: LEMMY_CATALOG_KEY,
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!response.ok) {
      throw new EvidenceEngineError('fetch_failed', 'Lemmy answered with an error', {
        catalog_key: LEMMY_CATALOG_KEY,
        status: response.status,
      });
    }
    const body = await response.text();
    hash.update(body);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new EvidenceEngineError('bad_response', 'Lemmy answered with invalid JSON', {
        catalog_key: LEMMY_CATALOG_KEY,
      });
    }
    const parsed = postListSchema.safeParse(json);
    if (!parsed.success) {
      throw new EvidenceEngineError('bad_response', 'Unexpected post list from Lemmy', {
        catalog_key: LEMMY_CATALOG_KEY,
      });
    }
    return parsed.data.posts.map((view) => view.post);
  }

  const usable = (post: LemmyPost): boolean =>
    post.local &&
    !post.deleted &&
    !post.removed &&
    !post.nsfw &&
    LANGUAGE_IDS.has(post.language_id) &&
    post.name.trim() !== '';

  return {
    catalogKey: LEMMY_CATALOG_KEY,

    async fetch(request: FetchRequest): Promise<ConnectorRun> {
      const hash = createHash('sha256');
      const urls = communities.map(listUrl);
      const posts = new Map<string, LemmyPost>();
      for (const url of urls) {
        for (const post of await getPosts(url, hash, request.signal)) {
          posts.set(String(post.id), post);
        }
      }
      const known = await request.known([...posts.keys()]);
      const fresh = [...posts.values()].filter((post) => !known.has(String(post.id)));
      const items: CollectedItem[] = fresh
        .filter(usable)
        .slice(0, request.maxItems)
        .map((post) => ({
          externalId: String(post.id),
          kind: 'post',
          text: [post.name.trim(), (post.body ?? '').trim()]
            .filter((part) => part !== '')
            .join('\n\n'),
          url: post.ap_id,
          observedAt: toTimestamp(new Date(post.published)),
          language: 'en',
        }));
      // The snapshot names the first request; the hash covers every response in order.
      return {
        requestUrl: urls[0] ?? baseUrl,
        contentSha256: hash.digest('hex'),
        itemCount: fresh.length,
        items,
      };
    },
  };
}
