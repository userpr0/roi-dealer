import {
  writeLandingTask,
  type WriteLandingInput,
  type WriteLandingOutput,
} from '@roi-dealer/media';

/*
 * Answers of the fake model for the landing writer (PHASE 19a): a page that passes the checks
 * in code and speaks about the customer of the input.
 */

/** A correct landing for the input: about its customer, without invented proof or numbers. */
export function perfectLandingAnswer(
  input: Pick<WriteLandingInput, 'opportunity' | 'hypothesis'>,
  options: { readonly headline?: string } = {},
): WriteLandingOutput {
  const customer = input.opportunity.icp;
  return {
    headline: options.headline ?? `${input.opportunity.change} for ${customer}`.slice(0, 90),
    subheadline: `For ${customer}: ${input.opportunity.problem.toLowerCase()}, solved.`.slice(
      0,
      200,
    ),
    problem: `${input.opportunity.problem}. It costs time and money every week.`,
    benefits: [
      { title: 'Less manual work', text: 'The routine part runs on its own.' },
      { title: 'Fewer surprises', text: 'You see problems before they cost you.' },
      { title: 'Simple setup', text: 'Connect what you already use.' },
    ],
    steps: ['Tell us what you use today.', 'We set it up with you.', 'It runs on its own.'],
    offer: 'Early access to the first version.',
    pricePeriod: 'per_month',
    cta: input.hypothesis.method === 'preorder' ? 'Preorder now' : 'Join the waitlist',
    faq: [
      { question: 'When is it ready?', answer: 'We are building it now and will email you.' },
      { question: 'Can I cancel?', answer: 'Yes, at any time.' },
    ],
    ads: [
      { headline: 'Stop doing it by hand', body: `Made for ${customer}.`.slice(0, 150) },
      { headline: 'Get your evenings back', body: 'The routine part runs on its own.' },
      { headline: 'Be first to try it', body: 'Join the waitlist for early access.' },
    ],
  };
}

/** The golden inputs of `write-landing` by their rendered prompt. */
export function landingGolden(): ReadonlyMap<string, WriteLandingInput> {
  return new Map(
    writeLandingTask.evalCases.map((item) => [writeLandingTask.render(item.input), item.input]),
  );
}
