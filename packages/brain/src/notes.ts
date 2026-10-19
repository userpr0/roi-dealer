import type { NewKnowledgeAsset } from '@roi-dealer/domain';

/** The tag of the owner's own notes (PHASE 08). */
export const OWNER_NOTE_TAG = 'owner-note';
export const MAX_NOTE_LENGTH = 3_000;
const TITLE_LENGTH = 120;

/**
 * ➕ An owner's note as a knowledge entry (§2.9): the first line is the title, the whole text the
 * summary. `empty` or `too_long` when it cannot be stored.
 */
export function ownerNote(text: string): NewKnowledgeAsset | 'empty' | 'too_long' {
  const body = text.trim();
  if (body === '') return 'empty';
  if (body.length > MAX_NOTE_LENGTH) return 'too_long';
  const firstLine = (body.split('\n')[0] ?? body).replace(/\s+/g, ' ').trim();
  const title =
    firstLine.length <= TITLE_LENGTH
      ? firstLine
      : `${firstLine.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
  return {
    kind: 'knowledge',
    title,
    summary: body,
    links: { evidenceIds: [] },
    tags: [OWNER_NOTE_TAG],
  };
}
