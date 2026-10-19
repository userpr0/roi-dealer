/**
 * @roi-dealer/brain — Company Brain v0.1 (PHASE 08).
 *
 * Finds what the system knows — pains, opportunities, evidence, knowledge, decisions — with
 * PostgreSQL full-text search, answers the owner's questions with fixed queries and their source
 * (§2.13, §7.3: no number comes from an AI), turns the owner's notes into knowledge entries and
 * retrieves similar past cases for the judges and the decision card.
 */
export { MAX_NOTE_LENGTH, OWNER_NOTE_TAG, ownerNote } from './notes.js';
export {
  answerQuestion,
  PERIOD_KEYS,
  periodRange,
  planQuestion,
  type PeriodKey,
  type QuestionAnswer,
  type QuestionPlan,
} from './questions.js';
export { CASE_TYPES, searchBrain, similarCases, type BrainSearchResult } from './search.js';

export const PACKAGE_NAME = '@roi-dealer/brain';
