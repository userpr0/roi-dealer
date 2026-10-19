import { describe, expect, it } from 'vitest';
import { decisionRationale, opportunityCardText, type CardData } from '@roi-dealer/command-center';
import type { StoredJudgement } from '@roi-dealer/database';
import {
  createOpportunity,
  evidenceIdSchema,
  JUDGE_CRITERIA,
  judgePanel,
  opportunityIdSchema,
  painIdSchema,
  recommendOpportunity,
  toTimestamp,
  type Evidence,
  type JudgeCriterion,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { SYSTEM } from '../../support/domain.js';

type Scores = Partial<Record<JudgeCriterion, number>>;
const all = (score: number, overrides: Scores = {}): Scores => ({
  ...Object.fromEntries(JUDGE_CRITERIA.map((criterion) => [criterion, score])),
  ...overrides,
});
const recommend = (scores: Scores) => recommendOpportunity(judgePanel(scores));

describe('the system recommends by fixed rules (PHASE 12, §2.13)', () => {
  it.each([
    [{ market: 5, pain_value: 5 }, 'more_research', 'incomplete'],
    [all(5, { market: 1 }), 'reject', 'critical_weakness'],
    [all(5, { economics: 1 }), 'reject', 'critical_weakness'],
    [all(5, { risk: 1 }), 'reject', 'critical_weakness'],
    [all(2, { market: 3, reuse: 3 }), 'reject', 'low_total'],
    [all(4), 'approve', 'strong'],
    [all(5, { buildability: 3 }), 'approve', 'strong'],
    [all(4, { risk: 2 }), 'more_research', 'mixed'],
    [all(3, { market: 4, reuse: 4 }), 'more_research', 'mixed'],
  ] as const)('%o → %s (%s)', (scores, outcome, reason) => {
    expect(recommend(scores)).toEqual({ outcome, reason });
  });

  it('treats buildability and reuse at 1 as weak spots, not as critical', () => {
    expect(recommend(all(5, { buildability: 1 }))).toEqual({
      outcome: 'more_research',
      reason: 'mixed',
    });
  });
});

describe('the decision card shows the facts and the recommendation', () => {
  const opportunity = createOpportunity(
    {
      title: 'Invoices that get paid without chasing',
      summary: 'Freelancers lose days chasing late invoices.',
      painIds: [painIdSchema.parse(uuidv7())],
      icp: 'Freelancers and two-person studios',
      markets: ['US'],
      valueProposition: {
        problem: 'Clients pay invoices late',
        change: 'Reminders and follow-ups run on their own',
        measurableResult: 'A day a month back',
      },
      businessModel: { model: 'subscription', pricingHypothesis: '$12 a month' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: toTimestamp(new Date()) },
  );
  const judgement = (criterion: JudgeCriterion, score: number): StoredJudgement => ({
    id: 1,
    occurredAt: toTimestamp(new Date()),
    opportunityId: opportunity.id,
    opportunityVersion: 1,
    criterion,
    taskVersion: 1,
    outcome: 'judged',
    score,
    supported: true,
    rationale: `The posts support a score of ${String(score)}.`,
    concerns: criterion === 'risk' ? ['Payment reminders may be seen as spam.'] : [],
    evidenceIds: [],
    actorType: 'agent',
    actorId: 'judges',
  });
  const scores = all(4, { risk: 2 }) as Record<JudgeCriterion, number>;
  const judgements = JUDGE_CRITERIA.map((criterion) => judgement(criterion, scores[criterion]));
  const panel = judgePanel(scores);
  const evidence = [
    {
      id: evidenceIdSchema.parse(uuidv7()),
      excerpt: 'I lose about $2,000 a year to clients who never pay.',
      url: 'https://news.ycombinator.com/item?id=10',
    },
    { id: evidenceIdSchema.parse(uuidv7()), excerpt: 'I spend every Friday chasing invoices.' },
    { id: evidenceIdSchema.parse(uuidv7()), excerpt: 'A third post.' },
  ] as unknown as Evidence[];
  const data: CardData = {
    opportunity,
    score: { score: 62, components: { frequency: 15, severity: 12, willingness: 10 } },
    judgements,
    panel,
    recommendation: recommendOpportunity(panel),
    market: {
      version: 1,
      alternatives: [
        {
          name: 'FreshBooks',
          kind: 'product',
          quote: 'FreshBooks reminders',
          evidenceId: evidence[0]?.id as Evidence['id'],
        },
      ],
      money: [
        {
          amountUsd: 2_000,
          period: 'year',
          quote: '$2,000 a year',
          evidenceId: evidence[0]?.id as Evidence['id'],
        },
      ],
      buyers: [],
    },
    evidence,
    sources: 1,
  };

  it('in one message, from the database, ending with the recommendation', () => {
    const text = opportunityCardText(data);
    expect(text.split('\n')).toEqual([
      '💡 Возможность на решение',
      '«Invoices that get paid without chasing»',
      'Клиент: Freelancers and two-person studios',
      'Проблема: Clients pay invoices late',
      'Изменение: Reminders and follow-ups run on their own',
      'Результат: A day a month back',
      'Модель: подписка · $12 a month',
      'Оценка: 62/100 (частота 15 · тяжесть 12 · готовность платить 10)',
      '⚖️ Судьи: 67/100 · рынок 4 · боль 4 · экономика 4 · сборка 4 · риск 2 · повтор 4',
      'Слабые места: риск',
      '   – риск: Payment reminders may be seen as spam.',
      'Рынок: сейчас — FreshBooks · суммы — $2,000/год',
      'Доказательства: 3 из 1 источн.',
      '• «I lose about $2,000 a year to clients who never pay.» https://news.ycombinator.com/item?id=10',
      '• «I spend every Friday chasing invoices.»',
      '',
      'Рекомендация системы: 🔍 доисследовать — слабые места: риск.',
      'Решаете вы.',
    ]);
    const long = opportunityCardText({
      ...data,
      opportunity: { ...opportunity, icp: 'x'.repeat(5_000) },
      evidence: Array.from({ length: 40 }, () => evidence[0] as Evidence),
    });
    expect(long.length).toBeLessThanOrEqual(4_000);
  });

  it('records a lesson with the owner’s decision', () => {
    expect(decisionRationale(data, 'approve')).toBe(
      'Owner decision: approve. Opportunity: Invoices that get paid without chasing. ' +
        'Judges 67/100 (market 4, pain_value 4, economics 4, buildability 4, risk 2, reuse 4); weak: risk. ' +
        'System recommendation: more_research (mixed). Customer: Freelancers and two-person studios. ' +
        'Problem: Clients pay invoices late. Business model: subscription.',
    );
  });
});
