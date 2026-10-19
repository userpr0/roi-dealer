import { describe, expect, it } from 'vitest';
import {
  AI_TASKS,
  callCostMicroUsd,
  EVAL_DAILY_SHARE,
  MIN_EVAL_CASES,
  MODEL_REGISTRY,
} from '@roi-dealer/ai-runtime';
import {
  addSignalToPain,
  changePainStatus,
  createPain,
  createSignal,
  evidenceIdSchema,
  frequencyForSignals,
  painIdSchema,
  signalIdSchema,
  type NewPain,
  type Pain,
} from '@roi-dealer/domain';
import {
  closestPains,
  extractSignalTask,
  matchedKey,
  matchPainTask,
  MAX_CANDIDATES,
  NO_MATCH,
  painTerms,
  quoteInText,
  scoreExtractSignal,
  scoreMatchPain,
  SIGNAL_TASKS,
  termSimilarity,
  toSignalDraft,
  type ExtractSignalOutput,
} from '@roi-dealer/signals';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at, createCtx, ctx } from '../../support/domain.js';

const answer = (overrides: Partial<ExtractSignalOutput> = {}): ExtractSignalOutput => ({
  pain: true,
  statement: 'Freelancers struggle to get clients to pay invoices on time',
  audience: 'Freelance designers',
  outcome: 'Get paid on time',
  strength: 'strong',
  quote: 'half my clients pay 60+ days late',
  ...overrides,
});
const TEXT =
  "I'm a freelance designer and half my clients pay 60+ days late. I spend every Friday chasing.";

function painData(overrides: Partial<NewPain> = {}): NewPain {
  return {
    title: 'Freelancers struggle to get paid on time',
    description: 'Late client payments',
    audience: 'Freelancers',
    desiredOutcome: 'Get paid on time',
    severity: 3,
    frequency: 'rare',
    markets: ['US'],
    signalIds: [signalIdSchema.parse(uuidv7())],
    evidenceIds: [evidenceIdSchema.parse(uuidv7())],
    ...overrides,
  };
}

const pain = (overrides: Partial<NewPain> = {}): Pain =>
  createPain(painData(overrides), createCtx(painIdSchema, AGENT));

describe('word similarity of pains', () => {
  it('keeps content words, lower case, without stop words and simple endings', () => {
    expect([...painTerms('Freelancers are chasing the unpaid Invoices!')]).toEqual([
      'freelancer',
      'chas',
      'unpaid',
      'invoic',
    ]);
  });

  it('measures the share of common words', () => {
    expect(termSimilarity(painTerms('late invoice payments'), painTerms('late invoice'))).toBe(0.8);
    expect(termSimilarity(painTerms('late invoices'), painTerms('noisy alerts'))).toBe(0);
    expect(termSimilarity(new Set(), painTerms('anything'))).toBe(0);
  });

  it('offers the closest open pains, most similar first, at most ten', () => {
    const invoices = pain({ title: 'Freelancers wait months for clients to pay invoices' });
    const payouts = pain({
      title: 'Agencies reconcile payment payouts by hand',
      audience: 'Agencies',
    });
    const alerts = pain({ title: 'Small teams burn out from noisy alerts', audience: 'Engineers' });
    const closest = closestPains(
      'Freelancers cannot get clients to pay invoices on time',
      'Freelancers',
      [alerts, payouts, invoices],
    );
    expect(closest[0]).toBe(invoices);
    expect(closest).not.toContain(alerts);
    const many = Array.from({ length: 15 }, () => pain());
    expect(
      closestPains('Freelancers struggle to get paid on time', 'Freelancers', many),
    ).toHaveLength(MAX_CANDIDATES);
  });
});

describe('code checks what the model proposes (§2.3, §2.5)', () => {
  it('accepts a pain whose quote is in the text, also with curly quotes and an ellipsis', () => {
    expect(toSignalDraft(TEXT, answer())).toEqual({
      statement: 'Freelancers struggle to get clients to pay invoices on time',
      audience: 'Freelance designers',
      outcome: 'Get paid on time',
      strength: 'strong',
      quote: 'half my clients pay 60+ days late',
    });
    expect(toSignalDraft(TEXT, answer({ quote: '“Half my clients pay 60+ days late…”' }))).not.toBe(
      'rejected',
    );
    expect(quoteInText("I'm  a FREELANCE designer", 'i’m a freelance designer')).toBe(true);
  });

  it('rejects an invented or too short quote and an unusable statement', () => {
    expect(toSignalDraft(TEXT, answer({ quote: 'clients never pay at all' }))).toBe('rejected');
    expect(toSignalDraft(TEXT, answer({ quote: 'late' }))).toBe('rejected');
    expect(toSignalDraft(TEXT, answer({ statement: 'Late' }))).toBe('rejected');
  });

  it('returns nothing when there is no pain and fills in missing audience and outcome', () => {
    expect(toSignalDraft(TEXT, answer({ pain: false }))).toBeUndefined();
    expect(toSignalDraft(TEXT, answer({ audience: ' ', outcome: '' }))).toMatchObject({
      audience: 'Not stated in the evidence',
      outcome: 'Not stated in the evidence',
    });
  });

  it('maps a match key back and treats anything else as none', () => {
    expect(matchedKey({ match: ' p2 ' }, ['P1', 'P2'])).toBe('P2');
    expect(matchedKey({ match: 'P7' }, ['P1', 'P2'])).toBe(NO_MATCH);
    expect(matchedKey({ match: 'The first one' }, ['P1'])).toBe(NO_MATCH);
  });
});

describe('golden sets of the PHASE 06 tasks (D-014 п.7)', () => {
  it('extract-signal: 24 cases, half pains; perfect answers pass, wrong ones fail', () => {
    const { evalCases } = extractSignalTask;
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    expect(evalCases.filter((c) => c.expected.pain)).toHaveLength(12);
    for (const testCase of evalCases) {
      expect(extractSignalTask.input.safeParse(testCase.input).success).toBe(true);
    }
    const perfect = evalCases.map((c) => ({
      expected: c.expected,
      output: c.expected.pain
        ? answer({ quote: c.expected.text.slice(0, 40) })
        : answer({ pain: false, statement: '', audience: '', outcome: '', quote: '' }),
    }));
    expect(scoreExtractSignal(perfect)).toEqual(scoreExtractSignal(perfect));
    expect(scoreExtractSignal(perfect)).toEqual({
      passed: true,
      metrics: { precision: 1, recall: 1, quotes: 1, answered: 1 },
    });
    // Everything is a pain: precision drops.
    const eager = evalCases.map((c) => ({
      expected: c.expected,
      output: answer({ quote: c.expected.text.slice(0, 40) }),
    }));
    expect(scoreExtractSignal(eager)).toMatchObject({ passed: false, metrics: { precision: 0.5 } });
    // Invented quotes fail even when the detection is right.
    const invented = perfect.map((item) =>
      item.expected.pain ? { ...item, output: answer({ quote: 'words not in the post' }) } : item,
    );
    expect(scoreExtractSignal(invented)).toMatchObject({ passed: false, metrics: { quotes: 0 } });
  });

  it('match-pain: 20 cases with both matches and none; perfect answers pass', () => {
    const { evalCases } = matchPainTask;
    expect(evalCases.length).toBeGreaterThanOrEqual(MIN_EVAL_CASES);
    expect(evalCases.some((c) => c.expected === NO_MATCH)).toBe(true);
    for (const testCase of evalCases) {
      expect(matchPainTask.input.safeParse(testCase.input).success).toBe(true);
      expect([NO_MATCH, ...testCase.input.candidates.map((c) => c.key)]).toContain(
        testCase.expected,
      );
    }
    const perfect = evalCases.map((c) => ({ expected: c.expected, output: { match: c.expected } }));
    expect(scoreMatchPain(perfect)).toEqual({
      passed: true,
      metrics: { accuracy: 1, answered: 1 },
    });
    const lazy = evalCases.map((c) => ({ expected: c.expected, output: { match: NO_MATCH } }));
    expect(scoreMatchPain(lazy).passed).toBe(false);
  });

  it('all AI tasks together keep their shares of the day within 1 (D-021)', () => {
    const tasks = [...AI_TASKS, ...SIGNAL_TASKS];
    expect(new Set(tasks.map((task) => task.name)).size).toBe(tasks.length);
    const total = tasks.reduce((sum, task) => sum + task.dailyShare, EVAL_DAILY_SHARE);
    expect(total).toBeLessThanOrEqual(1);
  });

  it('reserve at least the worst-case cost of one call on every bulk model', () => {
    const worstInput = {
      'extract-signal': extractSignalTask.instructions.length + 1_200 + 100,
      'match-pain': matchPainTask.instructions.length + 11 * 520 + 200,
    };
    for (const task of [extractSignalTask, matchPainTask]) {
      for (const model of MODEL_REGISTRY.filter((item) => item.tier === task.tier)) {
        expect(
          callCostMicroUsd(
            model,
            worstInput[task.name as keyof typeof worstInput],
            task.maxOutputTokens,
          ),
        ).toBeLessThanOrEqual(task.maxCostMicroUsd);
      }
    }
  });
});

describe('addSignalToPain (PHASE 06)', () => {
  const signal = (strength: 'weak' | 'moderate' | 'strong', markets = ['GB']) =>
    createSignal(
      {
        title: 'Freelancers wait for payments',
        summary: 'Late payments',
        evidenceIds: [evidenceIdSchema.parse(uuidv7())],
        markets,
        strength,
      },
      createCtx(signalIdSchema, AGENT),
    );

  it('joins evidence and markets, keeps the strongest severity and counts frequency', () => {
    const start = pain();
    const strong = signal('strong');
    const next = addSignalToPain(start, strong, ctx(AGENT, 5));
    expect(next).toMatchObject({
      version: 2,
      updatedAt: at(5),
      severity: 4,
      frequency: 'occasional',
      markets: ['US', 'GB'],
      signalIds: [...start.signalIds, strong.id],
      evidenceIds: [...start.evidenceIds, ...strong.evidenceIds],
    });
    expect(addSignalToPain(next, signal('weak', ['US']), ctx(AGENT, 6)).severity).toBe(4);
  });

  it('refuses a closed pain, a repeated signal and a full pain', () => {
    const open = pain();
    const strong = signal('strong');
    expect(() =>
      addSignalToPain(changePainStatus(open, 'rejected', ctx(AGENT, 1)), strong, ctx(AGENT, 2)),
    ).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
    const joined = addSignalToPain(open, strong, ctx(AGENT, 1));
    expect(() => addSignalToPain(joined, strong, ctx(AGENT, 2))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
    const full = pain({
      signalIds: Array.from({ length: 100 }, () => signalIdSchema.parse(uuidv7())),
    });
    expect(() => addSignalToPain(full, strong, ctx(AGENT, 1))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });

  it('turns the number of signals into a frequency', () => {
    expect([1, 2, 4, 5, 14, 15, 100].map(frequencyForSignals)).toEqual([
      'rare',
      'occasional',
      'occasional',
      'frequent',
      'frequent',
      'constant',
      'constant',
    ]);
  });
});
