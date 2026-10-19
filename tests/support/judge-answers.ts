import { judgeOpportunityTask, type JudgeExpected, type JudgeOutput } from '@roi-dealer/judges';

/** A correct answer to a golden case of `judge-opportunity`: in range, citing an excerpt. */
export function perfectJudgeAnswer(expected: JudgeExpected): JudgeOutput {
  return {
    score: Math.round((expected.min + expected.max) / 2),
    rationale: 'The excerpts show how often this happens and what it costs the customer.',
    evidence: [1],
    concerns: ['Check how many customers there are beyond one forum.'],
  };
}

/** The golden expectations by rendered prompt. */
export function judgeGolden(): ReadonlyMap<string, JudgeExpected> {
  return new Map(
    judgeOpportunityTask.evalCases.map((c) => [judgeOpportunityTask.render(c.input), c.expected]),
  );
}
