import {
  marketContextTask,
  researchQueryTask,
  type MarketContextExpected,
  type MarketContextOutput,
  type ResearchQueryExpected,
  type ResearchQueryOutput,
} from '@roi-dealer/agents';

/*
 * Correct answers to the golden sets of the PHASE 10 tasks, for the fake AI: what a model that
 * passes the evals would say.
 */

export function perfectResearchAnswer(expected: ResearchQueryExpected): ResearchQueryOutput {
  return { queries: [`${expected.keys[0] ?? 'problem'} help`] };
}

/** Each expected alternative and every excerpt with a dollar amount, quoting the whole excerpt. */
export function perfectMarketAnswer(expected: MarketContextExpected): MarketContextOutput {
  const indexOf = (word: string) =>
    expected.excerpts.findIndex((excerpt) => excerpt.toLowerCase().includes(word));
  return {
    alternatives: expected.alternatives.flatMap((group) => {
      const name = group.find((word) => indexOf(word) >= 0);
      if (name === undefined) return [];
      const index = indexOf(name);
      return [
        {
          name,
          kind: 'product' as const,
          quote: expected.excerpts[index] ?? '',
          excerpt: index + 1,
        },
      ];
    }),
    money: expected.excerpts.flatMap((excerpt, index) =>
      excerpt.includes('$')
        ? [{ period: 'unknown' as const, quote: excerpt, excerpt: index + 1 }]
        : [],
    ),
    buyers: [],
  };
}

/** The golden expectations of both tasks by their rendered prompt. */
export function agentGolden(): {
  readonly research: ReadonlyMap<string, ResearchQueryExpected>;
  readonly market: ReadonlyMap<string, MarketContextExpected>;
} {
  return {
    research: new Map(
      researchQueryTask.evalCases.map((c) => [researchQueryTask.render(c.input), c.expected]),
    ),
    market: new Map(
      marketContextTask.evalCases.map((c) => [marketContextTask.render(c.input), c.expected]),
    ),
  };
}
