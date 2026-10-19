import type { Pain } from '@roi-dealer/domain';

/*
 * Word similarity of pain statements (PHASE 06): a free first pass before the AI compares the
 * closest pains. Deterministic and cheap; paraphrases are left to the `match-pain` task.
 */

/** Below this share of common words a pain is not even shown to the AI. */
export const MIN_SIMILARITY = 0.15;
/** At most this many candidates go to `match-pain`. */
export const MAX_CANDIDATES = 10;

const STOP_WORDS: ReadonlySet<string> = new Set(
  [
    'about after again all also and any are because been being but can cannot could does doing',
    'don each even every for from get gets getting had has have having her his how into its',
    'just like lot make many more most much not off only other our out over own same she',
    'should some struggle struggles such than that the their them then there these they this',
    'those too very was way were what when where which while who why will with without would',
    'you your',
  ]
    .join(' ')
    .split(' '),
);

const SUFFIXES = ['ing', 'ed', 'es', 's', 'ly'] as const;

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Content words of a text: lower case, without stop words, with simple suffix stripping. */
export function painTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
      .map(stem),
  );
}

/** Dice coefficient of two word sets, in [0, 1]. */
export function termSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const term of a) if (b.has(term)) common += 1;
  return (2 * common) / (a.size + b.size);
}

/** The open pains closest to a statement, most similar first. */
export function closestPains(statement: string, audience: string, pains: readonly Pain[]): Pain[] {
  const terms = painTerms(`${statement} ${audience}`);
  return pains
    .map((pain) => ({
      pain,
      score: termSimilarity(terms, painTerms(`${pain.title} ${pain.audience}`)),
    }))
    .filter((item) => item.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map((item) => item.pain);
}
