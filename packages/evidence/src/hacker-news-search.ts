import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toTimestamp } from '@roi-dealer/domain';
import type { CollectedItem, ConnectorRun, FetchRequest, SourceConnector } from './connector.js';
import { EvidenceEngineError } from './errors.js';
import { HACKER_NEWS_CATALOG_KEY } from './hacker-news.js';
import { htmlToText } from './html.js';

/** HN Search API by Algolia (hn.algolia.com/api): the search the Hacker News site links to. */
export const HACKER_NEWS_SEARCH_URL = 'https://hn.algolia.com/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const HITS_PER_PAGE = 30;
/** Only these fields are requested; the author is never asked for, read or stored. */
const ATTRIBUTES = 'objectID,title,story_text,created_at_i';
export const MAX_QUERY_LENGTH = 60;

const responseSchema = z.object({
  hits: z
    .array(
      z.object({
        objectID: z.string().regex(/^\d{1,12}$/),
        title: z.string().nullable().optional(),
        story_text: z.string().nullable().optional(),
        created_at_i: z.int().nonnegative().optional(),
      }),
    )
    .max(1_000),
});

/**
 * Ask HN stories found by words (PHASE 10, research agent): the same source and ids as the Ask
 * HN list, so known posts are skipped and nothing is stored twice. Needs `request.query`.
 */
export function createHackerNewsSearchConnector(
  options: { readonly baseUrl?: string; readonly requestTimeoutMs?: number } = {},
): SourceConnector {
  const baseUrl = (options.baseUrl ?? HACKER_NEWS_SEARCH_URL).replace(/\/+$/, '');
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    catalogKey: HACKER_NEWS_CATALOG_KEY,

    async fetch(request: FetchRequest): Promise<ConnectorRun> {
      const query = request.query?.trim() ?? '';
      if (query === '' || query.length > MAX_QUERY_LENGTH) {
        throw new EvidenceEngineError('bad_request', 'A search needs words', {
          catalog_key: HACKER_NEWS_CATALOG_KEY,
        });
      }
      const params = new URLSearchParams({
        query,
        tags: 'ask_hn',
        hitsPerPage: String(HITS_PER_PAGE),
        attributesToRetrieve: ATTRIBUTES,
      });
      const requestUrl = `${baseUrl}/search?${params.toString()}`;
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          headers: { accept: 'application/json' },
          signal:
            request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]),
        });
      } catch (error) {
        throw new EvidenceEngineError('fetch_failed', 'HN Search is not reachable', {
          catalog_key: HACKER_NEWS_CATALOG_KEY,
          cause: error instanceof Error ? error.name : 'unknown',
        });
      }
      if (!response.ok) {
        throw new EvidenceEngineError('fetch_failed', 'HN Search answered with an error', {
          catalog_key: HACKER_NEWS_CATALOG_KEY,
          status: response.status,
        });
      }
      const body = await response.text();
      let parsed: z.infer<typeof responseSchema>;
      try {
        parsed = responseSchema.parse(JSON.parse(body));
      } catch {
        throw new EvidenceEngineError('bad_response', 'Unexpected answer from HN Search', {
          catalog_key: HACKER_NEWS_CATALOG_KEY,
        });
      }

      const known = await request.known(parsed.hits.map((hit) => hit.objectID));
      const fresh = parsed.hits.filter((hit) => !known.has(hit.objectID));
      const items: CollectedItem[] = [];
      for (const hit of fresh) {
        if (items.length >= request.maxItems) break;
        const title = hit.title?.trim() ?? '';
        if (title === '' || hit.created_at_i === undefined) continue;
        const text = htmlToText(hit.story_text ?? '');
        items.push({
          externalId: hit.objectID,
          kind: 'post',
          text: [title, text].filter((part) => part !== '').join('\n\n'),
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          observedAt: toTimestamp(new Date(hit.created_at_i * 1_000)),
          language: 'en',
        });
      }
      return {
        requestUrl,
        contentSha256: createHash('sha256').update(body).digest('hex'),
        itemCount: Math.min(fresh.length, request.maxItems),
        items,
      };
    },
  };
}
