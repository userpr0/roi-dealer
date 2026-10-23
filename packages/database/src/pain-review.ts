import type { Pain, PainId } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { readRows } from './repository.js';
import { painsTable } from './tables.js';

/** A pain in Russian for the owner (D-030). */
export interface PainTranslation {
  readonly titleRu: string;
  readonly audienceRu: string;
}

export interface PainTranslationEntry extends PainTranslation {
  readonly painId: PainId;
  readonly taskVersion: number;
}

/**
 * What the owner's review of pains reads (D-030): Russian titles and audiences (migration
 * 0020) — display data apart from the pain, so saving one never changes the pain or its
 * version — and the number of distinct sources behind each pain.
 */
export interface PainReviewQueries {
  /** Stores or replaces the translation of each pain. */
  saveTranslations(entries: readonly PainTranslationEntry[]): Promise<void>;
  /** Open pains without a translation, oldest first; default 10, at most 100. */
  pendingTranslations(options?: { readonly limit?: number | undefined }): Promise<Pain[]>;
  /** The translations of these pains that exist. */
  translations(ids: readonly PainId[]): Promise<ReadonlyMap<PainId, PainTranslation>>;
  /** Distinct sources of each pain's evidence; a pain without evidence is absent. */
  sourceCounts(ids: readonly PainId[]): Promise<ReadonlyMap<PainId, number>>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export function createPainReviewQueries(executor: Executor): PainReviewQueries {
  return {
    saveTranslations: (entries) =>
      translated(async () => {
        for (const entry of entries) {
          await executor`
            insert into pain_translations (pain_id, title_ru, audience_ru, task_version)
            values (${entry.painId}, ${entry.titleRu}, ${entry.audienceRu}, ${entry.taskVersion})
            on conflict (pain_id) do update set
              title_ru = excluded.title_ru,
              audience_ru = excluded.audience_ru,
              task_version = excluded.task_version,
              translated_at = now()
          `;
        }
      }),

    pendingTranslations: (options = {}) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const rows = await executor<Row[]>`
          select p.* from pains p
          where p.status in ('candidate', 'validated')
            and not exists (select 1 from pain_translations t where t.pain_id = p.id)
          order by p.created_at, p.id
          limit ${limit}
        `;
        return readRows(executor, painsTable, rows);
      }),

    translations: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const rows = await executor<{ pain_id: PainId; title_ru: string; audience_ru: string }[]>`
          select pain_id, title_ru, audience_ru from pain_translations
          where pain_id = any(${[...ids]}::uuid[])
        `;
        return new Map(
          rows.map((row) => [row.pain_id, { titleRu: row.title_ru, audienceRu: row.audience_ru }]),
        );
      }),

    sourceCounts: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const rows = await executor<{ pain_id: PainId; sources: string }[]>`
          select pe.pain_id, count(distinct e.source_id) as sources
          from pain_evidence pe join evidence e on e.id = pe.evidence_id
          where pe.pain_id = any(${[...ids]}::uuid[])
          group by pe.pain_id
        `;
        return new Map(rows.map((row) => [row.pain_id, Number(row.sources)]));
      }),
  };
}
