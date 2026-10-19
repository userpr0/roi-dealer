import { describe, expect, it } from 'vitest';
import { ownerNote, periodRange, planQuestion } from '@roi-dealer/brain';
import { answerText, searchResultText } from '@roi-dealer/command-center';
import { anyWordsQuery } from '@roi-dealer/database';
import { toTimestamp } from '@roi-dealer/domain';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');

describe('questions are recognized by fixed rules (§7.3)', () => {
  it.each([
    ['Сколько потратили за неделю?', { kind: 'spend', period: 'week' }],
    ['сколько расходов', { kind: 'spend', period: 'month' }],
    ['How much did we spend today?', { kind: 'spend', period: 'day' }],
    ['Сколько ушло на AI за месяц?', { kind: 'ai_spend', period: 'month' }],
    ['расходы на ИИ вчера', { kind: 'ai_spend', period: 'yesterday' }],
    ['what did Claude cost this week', { kind: 'ai_spend', period: 'week' }],
    ['Сколько болей?', { kind: 'count', entity: 'pain', period: 'all' }],
    ['сколько возможностей за неделю', { kind: 'count', entity: 'opportunity', period: 'week' }],
    ['how many signals today', { kind: 'count', entity: 'signal', period: 'day' }],
    ['сколько доказательств за всё время', { kind: 'count', entity: 'evidence', period: 'all' }],
    ['Что нового?', { kind: 'news', period: 'day' }],
    ["what's new this week", { kind: 'news', period: 'week' }],
  ] as const)('%s', (question, plan) => {
    expect(planQuestion(question)).toEqual(plan);
  });

  it('turns anything else into a search with the question words', () => {
    expect(planQuestion('  late invoices for agencies ')).toEqual({
      kind: 'search',
      text: 'late invoices for agencies',
    });
    // "AI" inside another word is not the AI.
    expect(planQuestion('сколько стоит email рассылка')).toEqual({
      kind: 'spend',
      period: 'month',
    });
  });

  it('counts periods back from now', () => {
    const iso = (ms: number) => toTimestamp(new Date(ms));
    const day = 24 * 3_600_000;
    expect(periodRange('day', NOW)).toEqual({ from: iso(NOW - day), to: iso(NOW + 1) });
    expect(periodRange('yesterday', NOW)).toEqual({ from: iso(NOW - 2 * day), to: iso(NOW - day) });
    expect(periodRange('week', NOW).from).toBe(iso(NOW - 7 * day));
    expect(periodRange('month', NOW).from).toBe(iso(NOW - 30 * day));
    expect(periodRange('all', NOW)).toEqual({});
  });
});

describe('search words never reach SQL as syntax', () => {
  it('keeps only Latin letters and digits for the any-word query', () => {
    expect(anyWordsQuery("Late invoices'; DROP TABLE pains; -- & | ! :* ()")).toBe(
      'late:* | invoices:* | drop:* | table:* | pains:*',
    );
    expect(anyWordsQuery('боль и счета')).toBe('');
  });
});

describe('owner notes (§2.9)', () => {
  it('takes the first line as the title and the text as the summary', () => {
    expect(ownerNote('Agencies hate reconciling\nThey asked for a daily report.')).toEqual({
      kind: 'knowledge',
      title: 'Agencies hate reconciling',
      summary: 'Agencies hate reconciling\nThey asked for a daily report.',
      links: { evidenceIds: [] },
      tags: ['owner-note'],
    });
    expect(ownerNote(`${'a'.repeat(200)}`)).toMatchObject({ title: `${'a'.repeat(119)}…` });
    expect(ownerNote('   ')).toBe('empty');
    expect(ownerNote('x'.repeat(3_001))).toBe('too_long');
  });
});

describe('answers always show their source', () => {
  it('money, AI, counts and news', () => {
    expect(
      answerText('?', {
        kind: 'spend',
        period: 'week',
        totalCents: 1_250,
        byCategory: { infrastructure: 1_000, ai: 250 },
        entries: 3,
      }),
    ).toBe(
      [
        '💸 Расходы за последние 7 дней: $12.50 · записей 3',
        'По категориям: infrastructure $10.00 · ai $2.50',
        'Источник: журнал расходов (cost_entries, сторно вычтены) → /history',
      ].join('\n'),
    );
    expect(
      answerText('?', {
        kind: 'ai_spend',
        period: 'month',
        costMicroUsd: 420_000,
        calls: 120,
        failed: 3,
      }),
    ).toBe(
      '🤖 AI за последние 30 дней: $0.42 · вызовов 120, с ошибкой 3\nИсточник: журнал вызовов AI (ai_calls) → /status',
    );
    expect(
      answerText('?', {
        kind: 'count',
        entity: 'pain',
        period: 'all',
        created: 5,
        byStatus: { candidate: 4, validated: 1 },
      }),
    ).toBe(
      'Болей создано за всё время: 5\nСейчас: кандидат 4 · подтверждена 1\nИсточник: таблица pains → /pains',
    );
    expect(
      answerText('?', {
        kind: 'news',
        period: 'day',
        created: { evidence: 12, signal: 4, pain: 1, opportunity: 0, knowledge: 0, decision: 0 },
      }),
    ).toContain('🆕 Создано за последние 24 часа: доказательств 12 · сигналов 4 · болей 1');
  });

  it('search: hits with kind and date, similar cases, a hint for non-English words', () => {
    const hit = {
      type: 'pain' as const,
      id: 'x',
      title: 'Agencies reconcile payouts',
      snippet: 'They «reconcile» payouts by hand',
      createdAt: toTimestamp(new Date(NOW)),
      rank: 0.1,
    };
    const text = searchResultText('reconcile', {
      hits: [hit],
      similar: false,
      needsEnglish: false,
    });
    expect(text).toMatch(
      /^🔎 «reconcile» · найдено: 1\n\n1\. 🧩 Боль · Agencies reconcile payouts · /,
    );
    expect(text).toContain('   They «reconcile» payouts by hand');
    expect(
      searchResultText('reconcile', { hits: [hit], similar: true, needsEnglish: false }),
    ).toContain('точных совпадений нет, похожие записи');
    expect(searchResultText('боли', { hits: [], similar: false, needsEnglish: true })).toContain(
      'Данные в базе — на английском',
    );
    expect(searchResultText('zzz', { hits: [], similar: false, needsEnglish: false })).toContain(
      'ничего не найдено',
    );
  });
});
