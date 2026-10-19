/*
 * Judges (PHASE 11): six independent judgements of an opportunity, scored 1–5 (higher is better
 * for us; for risk, 5 means low risk). The panel result is computed here, by code (§2.13); the
 * owner decides (PHASE 12).
 */

export const JUDGE_CRITERIA = [
  'market',
  'pain_value',
  'economics',
  'buildability',
  'risk',
  'reuse',
] as const;
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

/** Criteria whose judgement must cite evidence (§2.5); without it the score is at most 2. */
export const EVIDENCE_REQUIRED: readonly JudgeCriterion[] = ['market', 'pain_value', 'economics'];
export const UNSUPPORTED_MAX_SCORE = 2;
export const MIN_JUDGE_SCORE = 1;
export const MAX_JUDGE_SCORE = 5;
/** A criterion with this score or lower is a weak spot of the opportunity. */
export const WEAK_SCORE = 2;

export interface JudgePanel {
  /** 0–100: the mean of (score − 1) / 4; only when every criterion has a score. */
  readonly total?: number | undefined;
  readonly scores: Readonly<Partial<Record<JudgeCriterion, number>>>;
  /** Criteria scored 2 or lower, in the order of `JUDGE_CRITERIA`. */
  readonly weak: readonly JudgeCriterion[];
  /** Criteria without a score yet (or whose judgement failed). */
  readonly missing: readonly JudgeCriterion[];
}

/** The panel of an opportunity from the scores of its judgements. */
export function judgePanel(scores: Readonly<Partial<Record<JudgeCriterion, number>>>): JudgePanel {
  const missing = JUDGE_CRITERIA.filter((criterion) => scores[criterion] === undefined);
  const weak = JUDGE_CRITERIA.filter(
    (criterion) => (scores[criterion] ?? WEAK_SCORE + 1) <= WEAK_SCORE,
  );
  const total =
    missing.length > 0
      ? undefined
      : Math.round(
          (JUDGE_CRITERIA.reduce((sum, criterion) => sum + ((scores[criterion] ?? 1) - 1), 0) /
            (JUDGE_CRITERIA.length * (MAX_JUDGE_SCORE - MIN_JUDGE_SCORE))) *
            100,
        );
  return { total, scores, weak, missing };
}
