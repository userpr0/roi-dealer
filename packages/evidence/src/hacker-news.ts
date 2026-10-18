import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toTimestamp } from '@roi-dealer/domain';
import type { CollectedItem, ConnectorRun, FetchRequest, SourceConnector } from './connector.js';
import { EvidenceEngineError } from './errors.js';
import { htmlToText } from './html.js';

/** Official Hacker News API (github.com/HackerNews/API): public, read-only, no key. */
export const HACKER_NEWS_API_URL = 'https://hacker-news.firebaseio.com/v0';
export const HACKER_NEWS_CATALOG_KEY = 'hacker-news';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REMEMBERED_SKIPS = 10_000;

const storyIdsSchema = z.array(z.int().positive()).max(1_000);

/**
 * An item as the API returns it; only the fields we use are read. `by` (the author) is
 * deliberately absent: it is never read or stored.
 */
const itemSchema = z
  .object({
    id: z.int().positive(),
    type: z.string().optional(),
    time: z.int().nonnegative().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    deleted: z.boolean().optional(),
    dead: z.boolean().optional(),
  })
  .nullable();

export interface HackerNewsOptions {
  /** Default: the official API; tests point it to a local fake. */
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
}

/**
 * Ask HN stories: the questions and problems people bring to the community. Reads the list of
 * current Ask HN ids, skips stored ones and loads at most `maxItems` new items one by one.
 */
export function createHackerNewsConnector(options: HackerNewsOptions = {}): SourceConnector {
  const baseUrl = (options.baseUrl ?? HACKER_NEWS_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // Items that were loaded but are not evidence (deleted, dead, comments): not stored, so
  // remembered here to avoid loading them again while they stay in the list.
  const skipped = new Set<string>();

  async function getJson(url: string, hash: ReturnType<typeof createHash>, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      throw new EvidenceEngineError('fetch_failed', 'Hacker News is not reachable', {
        catalog_key: HACKER_NEWS_CATALOG_KEY,
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!response.ok) {
      throw new EvidenceEngineError('fetch_failed', 'Hacker News answered with an error', {
        catalog_key: HACKER_NEWS_CATALOG_KEY,
        status: response.status,
      });
    }
    const body = await response.text();
    hash.update(body);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new EvidenceEngineError('bad_response', 'Hacker News answered with invalid JSON', {
        catalog_key: HACKER_NEWS_CATALOG_KEY,
      });
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new EvidenceEngineError('bad_response', `Unexpected ${what} from Hacker News`, {
        catalog_key: HACKER_NEWS_CATALOG_KEY,
      });
    }
    return parsed.data;
  }

  return {
    catalogKey: HACKER_NEWS_CATALOG_KEY,

    async fetch(request: FetchRequest): Promise<ConnectorRun> {
      const hash = createHash('sha256');
      const requestUrl = `${baseUrl}/askstories.json`;
      const ids = parse(
        storyIdsSchema,
        await getJson(requestUrl, hash, request.signal),
        'story list',
      );
      const known = await request.known(ids.map(String));
      const fresh = ids
        .filter((id) => !known.has(String(id)) && !skipped.has(String(id)))
        .slice(0, request.maxItems);
      if (skipped.size > MAX_REMEMBERED_SKIPS) skipped.clear();

      const items: CollectedItem[] = [];
      for (const id of fresh) {
        const item = parse(
          itemSchema,
          await getJson(`${baseUrl}/item/${String(id)}.json`, hash, request.signal),
          'item',
        );
        if (
          item === null ||
          item.deleted === true ||
          item.dead === true ||
          item.type !== 'story' ||
          item.title === undefined ||
          item.time === undefined
        ) {
          skipped.add(String(id));
          continue;
        }
        const body = item.text === undefined ? '' : htmlToText(item.text);
        const text = [item.title.trim(), body].filter((part) => part !== '').join('\n\n');
        items.push({
          externalId: String(item.id),
          kind: 'post',
          text,
          url: `https://news.ycombinator.com/item?id=${String(item.id)}`,
          observedAt: toTimestamp(new Date(item.time * 1_000)),
          language: 'en',
        });
      }
      return { requestUrl, contentSha256: hash.digest('hex'), itemCount: fresh.length, items };
    },
  };
}
