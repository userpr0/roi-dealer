import {
  designHypothesesTask,
  marketContextTask,
  researchQueryTask,
  type DesignHypothesesExpected,
  type DesignHypothesesOutput,
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

const METHODS = ['landing_page', 'demo', 'concierge', 'preorder', 'interviews'] as const;

/** Five valid, different hypotheses about the expected customer (PHASE 14). */
export function perfectHypothesesAnswer(
  expected: Pick<DesignHypothesesExpected, 'markets'> & { readonly audience: string },
): DesignHypothesesOutput {
  return {
    hypotheses: METHODS.map((method, index) => ({
      statement: `If we offer it to ${expected.audience}, at least 20 will sign up.`,
      audience: expected.audience,
      geo: expected.markets[0] ?? 'US',
      offer: `Early access, variant ${String(index + 1)}`,
      priceUsd: index === 4 ? 0 : 10 + index * 10,
      channel: index % 2 === 0 ? 'Reddit ads' : 'Cold email',
      creative: 'Get paid on time without chasing — coming soon.',
      cta: 'Join the waitlist',
      validationMethod: method,
      successMetric: { name: 'signups', target: 20, unit: 'people', direction: 'at_least' },
      budgetUsd: 50,
      stopLossUsd: 20,
      minimumData: '300 unique visitors',
    })),
  };
}

/** The golden expectations of the agents' tasks by their rendered prompt. */
export function agentGolden(): {
  readonly research: ReadonlyMap<string, ResearchQueryExpected>;
  readonly market: ReadonlyMap<string, MarketContextExpected>;
  readonly hypotheses: ReadonlyMap<
    string,
    DesignHypothesesExpected & { readonly audience: string }
  >;
} {
  return {
    hypotheses: new Map(
      designHypothesesTask.evalCases.map((c) => [
        designHypothesesTask.render(c.input),
        { ...c.expected, audience: c.input.opportunity.icp },
      ]),
    ),
    research: new Map(
      researchQueryTask.evalCases.map((c) => [researchQueryTask.render(c.input), c.expected]),
    ),
    market: new Map(
      marketContextTask.evalCases.map((c) => [marketContextTask.render(c.input), c.expected]),
    ),
  };
}
