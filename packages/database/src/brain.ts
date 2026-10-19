import type { Timestamp } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor } from './executor.js';
import { instant } from './rows.js';

/*
 * Company Brain queries (PHASE 08): fixed, parameterized, read-only. The search expressions are
 * exactly those of the indexes of migration 0009; the user's text is only ever a parameter.
 */

export const SEARCH_TYPES = ['pain', 'opportunity', 'evidence', 'knowledge', 'decision'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  readonly type: SearchType;
  readonly id: string;
  readonly title: string;
  /** A fragment around the found words, which are marked «like this». */
  readonly snippet: string;
  readonly createdAt: Timestamp;
  readonly rank: number;
}

export interface SearchOptions {
  readonly types?: readonly SearchType[] | undefined;
  /**
   * `all` — every word (default); `any` — any word or a longer form of it ("reconcile" also
   * finds "reconciliation"), for similar cases.
   */
  readonly mode?: 'all' | 'any' | undefined;
  /** Default 10, at most 50. */
  readonly limit?: number | undefined;
  readonly excludeIds?: readonly string[] | undefined;
}

export interface Period {
  /** Inclusive. */
  readonly from?: Timestamp | undefined;
  /** Exclusive. */
  readonly to?: Timestamp | undefined;
}

export const COUNTED_ENTITIES = [
  'pain',
  'opportunity',
  'signal',
  'evidence',
  'knowledge',
  'decision',
] as const;
export type CountedEntity = (typeof COUNTED_ENTITIES)[number];
export type StatusEntity = 'pain' | 'opportunity' | 'signal';

export interface CostTotals {
  /** Reversals subtract their amount (§2.8). */
  readonly totalCents: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly entries: number;
}

export interface BrainQueries {
  search(text: string, options?: SearchOptions): Promise<SearchHit[]>;
  countByStatus(entity: StatusEntity): Promise<Readonly<Record<string, number>>>;
  countCreated(entity: CountedEntity, period?: Period): Promise<number>;
  costTotals(period?: Period): Promise<CostTotals>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_TERMS = 20;
const HEADLINE = 'MaxWords=24, MinWords=10, ShortWord=2, StartSel=«, StopSel=»';

const TABLES: Readonly<Record<CountedEntity, string>> = {
  pain: 'pains',
  opportunity: 'opportunities',
  signal: 'signals',
  evidence: 'evidence',
  knowledge: 'knowledge_assets',
  decision: 'decisions',
};

/**
 * The `to_tsquery` text of an `any` search: only letters and digits survive, so no operator of
 * the user's reaches the query; every word is a prefix, joined with `|`.
 */
export function anyWordsQuery(text: string): string {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, MAX_TERMS);
  return terms.map((term) => `${term}:*`).join(' | ');
}

interface HitRow {
  id: string;
  title: string;
  snippet: string;
  created_at: unknown;
  rank: number;
}

export function createBrainQueries(executor: Executor): BrainQueries {
  const queryOf = (text: string, mode: 'all' | 'any') =>
    mode === 'any'
      ? executor`to_tsquery('english', ${anyWordsQuery(text)})`
      : executor`websearch_to_tsquery('english', ${text})`;
  const excluded = (ids: readonly string[]) =>
    ids.length === 0 ? executor`` : executor`and not (t.id = any(${[...ids]}::uuid[]))`;
  const period = (column: 'created_at' | 'incurred_at', range: Period) => executor`
    ${range.from === undefined ? executor`` : executor`and ${executor(column)} >= ${range.from}`}
    ${range.to === undefined ? executor`` : executor`and ${executor(column)} < ${range.to}`}
  `;

  async function searchType(
    type: SearchType,
    text: string,
    mode: 'all' | 'any',
    limit: number,
    excludeIds: readonly string[],
  ): Promise<SearchHit[]> {
    const q = queryOf(text, mode);
    const not = excluded(excludeIds);
    let rows: HitRow[];
    switch (type) {
      case 'pain':
        rows = await executor<HitRow[]>`
          select t.id, t.title, t.created_at,
            ts_headline('english', t.description, q, ${HEADLINE}) as snippet,
            ts_rank(to_tsvector('english', t.title || ' ' || t.description || ' ' || t.audience || ' ' || t.desired_outcome), q) as rank
          from pains t, ${q} q
          where to_tsvector('english', t.title || ' ' || t.description || ' ' || t.audience || ' ' || t.desired_outcome) @@ q
            ${not}
          order by rank desc, t.created_at desc limit ${limit}
        `;
        break;
      case 'opportunity':
        rows = await executor<HitRow[]>`
          select t.id, t.title, t.created_at,
            ts_headline('english', t.summary, q, ${HEADLINE}) as snippet,
            ts_rank(to_tsvector('english', t.title || ' ' || t.summary || ' ' || t.icp || ' ' || t.value_problem || ' ' || t.value_change || ' ' || t.value_measurable_result), q) as rank
          from opportunities t, ${q} q
          where to_tsvector('english', t.title || ' ' || t.summary || ' ' || t.icp || ' ' || t.value_problem || ' ' || t.value_change || ' ' || t.value_measurable_result) @@ q
            ${not}
          order by rank desc, t.created_at desc limit ${limit}
        `;
        break;
      case 'evidence':
        rows = await executor<HitRow[]>`
          select t.id, left(t.excerpt, 80) as title, t.created_at,
            ts_headline('english', t.excerpt, q, ${HEADLINE}) as snippet,
            ts_rank(to_tsvector('english', t.excerpt), q) as rank
          from evidence t, ${q} q
          where to_tsvector('english', t.excerpt) @@ q ${not}
          order by rank desc, t.created_at desc limit ${limit}
        `;
        break;
      case 'knowledge':
        rows = await executor<HitRow[]>`
          select t.id, t.title, t.created_at,
            ts_headline('english', t.summary, q, ${HEADLINE}) as snippet,
            ts_rank(to_tsvector('english', t.title || ' ' || t.summary || ' ' || coalesce(t.body, '')), q) as rank
          from knowledge_assets t, ${q} q
          where to_tsvector('english', t.title || ' ' || t.summary || ' ' || coalesce(t.body, '')) @@ q
            and not ('eval' = any(t.tags)) ${not}
          order by rank desc, t.created_at desc limit ${limit}
        `;
        break;
      case 'decision':
        rows = await executor<HitRow[]>`
          select t.id, t.outcome || ' · ' || t.subject_type as title, t.created_at,
            ts_headline('english', t.rationale, q, ${HEADLINE}) as snippet,
            ts_rank(to_tsvector('english', t.rationale), q) as rank
          from decisions t, ${q} q
          where to_tsvector('english', t.rationale) @@ q ${not}
          order by rank desc, t.created_at desc limit ${limit}
        `;
        break;
    }
    return rows.map((row) => ({
      type,
      id: String(row.id),
      title: row.title,
      snippet: row.snippet,
      createdAt: instant(row.created_at) as Timestamp,
      rank: Number(row.rank),
    }));
  }

  return {
    search: (text, options = {}) =>
      translated(async () => {
        const mode = options.mode ?? 'all';
        if (text.trim() === '' || (mode === 'any' && anyWordsQuery(text) === '')) return [];
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const hits: SearchHit[] = [];
        for (const type of options.types ?? SEARCH_TYPES) {
          hits.push(...(await searchType(type, text, mode, limit, options.excludeIds ?? [])));
        }
        return hits
          .sort((a, b) => b.rank - a.rank || b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit);
      }),

    countByStatus: (entity) =>
      translated(async () => {
        const rows = await executor<{ status: string; count: string }[]>`
          select status, count(*) as count from ${executor(TABLES[entity])} group by status
        `;
        return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
      }),

    countCreated: (entity, range = {}) =>
      translated(async () => {
        const evals = entity === 'knowledge' ? executor`and not ('eval' = any(tags))` : executor``;
        const [row] = await executor<{ count: string }[]>`
          select count(*) as count from ${executor(TABLES[entity])}
          where true ${period('created_at', range)} ${evals}
        `;
        return Number(row?.count ?? 0);
      }),

    costTotals: (range = {}) =>
      translated(async () => {
        const rows = await executor<{ category: string; cents: string; entries: string }[]>`
          select category,
            sum(case when reversal_of is null then amount_usd_cents else -amount_usd_cents end)
              as cents,
            count(*) as entries
          from cost_entries where true ${period('incurred_at', range)}
          group by category
        `;
        const byCategory = Object.fromEntries(rows.map((row) => [row.category, Number(row.cents)]));
        return {
          totalCents: rows.reduce((sum, row) => sum + Number(row.cents), 0),
          byCategory,
          entries: rows.reduce((sum, row) => sum + Number(row.entries), 0),
        };
      }),
  };
}
