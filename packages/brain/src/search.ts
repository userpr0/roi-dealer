import type { Database, SearchHit, SearchType } from '@roi-dealer/database';

export interface BrainSearchResult {
  readonly hits: readonly SearchHit[];
  /** No record has every word: these share some of them. */
  readonly similar: boolean;
  /** The words are not English: the data is, so nothing can match. */
  readonly needsEnglish: boolean;
}

const LATIN = /[a-z0-9]/i;
const CYRILLIC = /[а-яё]/i;

/**
 * 🔎 Search (PHASE 08): every word first; when nothing has them all, records with any of them
 * (similar cases). Texts are English, so a query without Latin letters gets a hint instead.
 */
export async function searchBrain(
  database: Pick<Database, 'brain'>,
  text: string,
  options: { readonly limit?: number | undefined } = {},
): Promise<BrainSearchResult> {
  const query = text.trim();
  if (!LATIN.test(query)) {
    return { hits: [], similar: false, needsEnglish: CYRILLIC.test(query) };
  }
  const exact = await database.brain.search(query, { mode: 'all', limit: options.limit });
  if (exact.length > 0) return { hits: exact, similar: false, needsEnglish: false };
  const similar = await database.brain.search(query, { mode: 'any', limit: options.limit });
  return { hits: similar, similar: similar.length > 0, needsEnglish: false };
}

/** Kinds of records that are cases to learn from: opportunities, knowledge, decisions. */
export const CASE_TYPES: readonly SearchType[] = ['opportunity', 'knowledge', 'decision'];

/**
 * Past cases similar to a text (PHASE 08), for the judges and the decision card (PHASE 11–12):
 * any of its words, best rank first, the given records left out.
 */
export function similarCases(
  database: Pick<Database, 'brain'>,
  text: string,
  options: { readonly excludeIds?: readonly string[]; readonly limit?: number } = {},
): Promise<SearchHit[]> {
  return database.brain.search(text, {
    mode: 'any',
    types: CASE_TYPES,
    excludeIds: options.excludeIds,
    limit: options.limit ?? 5,
  });
}
