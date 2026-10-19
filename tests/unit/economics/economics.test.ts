import { describe, expect, it } from 'vitest';
import {
  budgetState,
  createExperiment,
  createHypothesis,
  changeHypothesisStatus,
  costEntryIdSchema,
  experimentIdSchema,
  funnelMetric,
  hypothesisIdSchema,
  opportunityIdSchema,
  planExperiment,
  recordRefund,
  recordRevenueEntry,
  revenueEntryIdSchema,
  spendAnomaly,
  summarizeRevenue,
  unitEconomics,
  usd,
  ZERO_USD,
} from '@roi-dealer/domain';
import {
  economicsText,
  moneyLine,
  parseCostReport,
  parseFunnelReport,
} from '@roi-dealer/command-center';
import type { EconomicsReport } from '@roi-dealer/economics';
import { isPermitted } from '@roi-dealer/policies';
import { uuidv7 } from '@roi-dealer/shared';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  hypothesisData,
  INTEGRATION,
  OWNER,
  SYSTEM,
} from '../../support/domain.js';

const OPPORTUNITY = opportunityIdSchema.parse(uuidv7());

function revenue(cents: number, customers: number, kind: 'payment' | 'preorder' = 'payment') {
  return recordRevenueEntry(
    {
      kind,
      amount: usd(cents),
      customers,
      description: 'Owner report',
      receivedAt: at(1),
      allocation: { opportunityId: OPPORTUNITY },
    },
    createCtx(revenueEntryIdSchema, OWNER, 1),
  );
}

describe('the revenue ledger (PHASE 16)', () => {
  it('sums payments, preorders and customers; a reversal subtracts', () => {
    const paid = revenue(3_600, 3);
    const mistake = revenue(1_000, 1);
    const reversal = recordRevenueEntry(
      {
        kind: 'payment',
        amount: usd(1_000),
        customers: 1,
        description: 'Entered twice',
        receivedAt: at(2),
        allocation: {},
        reversalOf: mistake.id,
      },
      createCtx(revenueEntryIdSchema, OWNER, 2),
    );
    expect(summarizeRevenue([paid, mistake, reversal, revenue(5_000, 2, 'preorder')])).toEqual({
      payments: usd(3_600),
      preorders: usd(5_000),
      customers: 5,
    });
    expect(() => revenue(0, 1)).toThrow(/Invalid revenue_entry/);
  });

  it('is recorded only by the owner', () => {
    expect(isPermitted(OWNER, 'revenue.record')).toBe(true);
    for (const actor of [SYSTEM, AGENT, INTEGRATION]) {
      expect(isPermitted(actor, 'revenue.record')).toBe(false);
    }
  });
});

describe('limits, unit economics and the anomaly rule (D-007, D-014)', () => {
  it('marks a category at 80 % and at its limit', () => {
    expect(budgetState(usd(1_599), usd(2_000))).toBe('ok');
    expect(budgetState(usd(1_600), usd(2_000))).toBe('warning');
    expect(budgetState(usd(2_000), usd(2_000))).toBe('over');
  });

  it('computes CAC, revenue per customer and ROI; no divisor — no value', () => {
    expect(
      unitEconomics({
        spend: usd(1_000),
        payments: usd(3_600),
        preorders: ZERO_USD,
        refunds: usd(1_200),
        customers: 3,
      }),
    ).toEqual({
      netRevenue: usd(2_400),
      cac: usd(333),
      revenuePerCustomer: usd(800),
      roiPercent: 140,
    });
    expect(
      unitEconomics({
        spend: ZERO_USD,
        payments: ZERO_USD,
        preorders: ZERO_USD,
        refunds: ZERO_USD,
        customers: 0,
      }),
    ).toEqual({
      netRevenue: usd(0),
      cac: undefined,
      revenuePerCustomer: undefined,
      roiPercent: undefined,
    });
    expect(
      unitEconomics({
        spend: usd(2_000),
        payments: ZERO_USD,
        preorders: ZERO_USD,
        refunds: ZERO_USD,
        customers: 0,
      }).roiPercent,
    ).toBe(-100);
  });

  it('pauses at twice the seven-day average, never below $5', () => {
    const usual = [1_000_000, 1_200_000, 800_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000];
    expect(spendAnomaly(4_000_000, usual)).toEqual({
      anomalous: false,
      averageMicroUsd: 1_000_000,
      thresholdMicroUsd: 5_000_000,
    });
    const busy = usual.map((day) => day * 4);
    expect(spendAnomaly(8_000_000, busy)).toMatchObject({
      anomalous: true,
      thresholdMicroUsd: 8_000_000,
    });
    expect(spendAnomaly(7_999_999, busy).anomalous).toBe(false);
    // The first day with spend: no average, only the floor.
    expect(spendAnomaly(5_000_000, []).anomalous).toBe(true);
    expect(spendAnomaly(4_999_999, [0, 0, 0]).anomalous).toBe(false);
    // Only the last seven days count.
    expect(spendAnomaly(0, [99_000_000, ...usual]).averageMicroUsd).toBe(1_000_000);
  });
});

describe('refunds (PHASE 16)', () => {
  const selected = changeHypothesisStatus(
    createHypothesis(
      hypothesisData(OPPORTUNITY, { successMetric: funnelMetric({ stage: 'lead' }, 20) }),
      createCtx(hypothesisIdSchema, AGENT, 1),
    ),
    'selected',
    ctx(OWNER, 2),
  );
  const planned = createExperiment(
    planExperiment(selected),
    selected,
    createCtx(experimentIdSchema, OWNER, 3),
  );

  it('are refund costs of the test, at most the money received', () => {
    const running = { ...planned, status: 'running' as const };
    const refund = recordRefund(
      { amount: usd(1_200), description: 'Refund', incurredAt: at(5) },
      running,
      usd(3_600),
      createCtx(costEntryIdSchema, OWNER, 5),
    );
    expect(refund).toMatchObject({
      category: 'refund',
      recurring: false,
      allocation: {
        experimentId: planned.id,
        hypothesisId: selected.id,
        opportunityId: OPPORTUNITY,
      },
    });
    expect(() =>
      recordRefund(
        { amount: usd(3_601), description: 'Refund', incurredAt: at(5) },
        running,
        usd(3_600),
        createCtx(costEntryIdSchema, OWNER, 5),
      ),
    ).toThrow(/cannot exceed the money received/);
    expect(() =>
      recordRefund(
        { amount: usd(100), description: 'Refund', incurredAt: at(5) },
        planned,
        usd(3_600),
        createCtx(costEntryIdSchema, OWNER, 5),
      ),
    ).toThrow(/Only a launched experiment/);
  });
});

describe('owner reports (PHASE 16)', () => {
  it('/funnel reads revenue with its payments and refunds', () => {
    expect(parseFunnelReport('2 оплаты 3 выручка 36 вернули 12.5')).toEqual({
      number: 2,
      increments: { payment: 3 },
      spendCents: 0,
      revenueCents: 3_600,
      refundCents: 1_250,
    });
    expect(parseFunnelReport('2 выручка 36')).toContain('вместе с числом оплат');
    expect(parseFunnelReport('2 вернули')).toContain('сумма в долларах');
    expect(parseFunnelReport('2 повторные 4')).toMatchObject({ increments: { retention: 4 } });
  });

  it('/cost reads the amount, the category and what it was for', () => {
    expect(parseCostReport('5 инфраструктура Railway октябрь')).toEqual({
      amount: usd(500),
      category: 'infrastructure',
      description: 'Railway октябрь',
    });
    expect(parseCostReport('$25.50 vendor Logo design')).toMatchObject({
      amount: usd(2_550),
      category: 'vendor',
    });
    expect(parseCostReport('')).toContain('/cost <сумма>');
    expect(parseCostReport('5 ai tokens')).toContain('Не знаю категорию «ai»');
    expect(parseCostReport('5 реклама test')).toContain('Не знаю категорию');
    expect(parseCostReport('0 инфраструктура x')).toContain('Сумма — от $0.01');
    expect(parseCostReport('5 инфраструктура')).toContain('за что расход');
  });
});

describe('panel texts (PHASE 16)', () => {
  it('shows a test’s revenue and unit economics after the first money', () => {
    const flow = {
      spend: usd(1_000),
      payments: usd(3_600),
      preorders: ZERO_USD,
      refunds: ZERO_USD,
      customers: 3,
    };
    expect(moneyLine(flow)).toBe('Выручка $36.00 · клиентов 3 · CAC $3.33 · ROI +260 %');
    expect(moneyLine({ ...flow, payments: ZERO_USD, customers: 0 })).toBeUndefined();
    expect(
      moneyLine({
        ...flow,
        payments: ZERO_USD,
        preorders: usd(4_000),
        refunds: usd(1_000),
        customers: 2,
      }),
    ).toBe(
      'Выручка $40.00 (предзаказы $40.00) · клиентов 2 · возвраты $10.00 · CAC $5.00 · ROI +200 %',
    );
  });

  it('/economics lists the month against the limits with its sources', () => {
    const report: EconomicsReport = {
      month: '2026-10',
      costs: new Map([
        ['ai', usd(4_100)],
        ['infrastructure', usd(2_100)],
        ['ads', usd(1_250)],
      ]),
      ai: { monthMicroUsd: 41_000_000, todayMicroUsd: 310_000, allowanceMicroUsd: 1_530_000 },
      budgets: [
        { category: 'infrastructure', spent: usd(2_100), limit: usd(2_000), state: 'over' },
        { category: 'ai', spent: usd(4_100), limit: usd(5_000), state: 'warning' },
      ],
      tests: { active: 1, approved: usd(5_000), spent: usd(1_250) },
      revenue: { payments: usd(3_600), preorders: usd(4_000), customers: 5 },
      refunds: usd(1_200),
      totalCosts: usd(7_450),
      roiPercent: 32,
      testedHypotheses: 2,
      costPerTestedHypothesis: usd(625),
    };
    const text = economicsText(report);
    expect(text).toContain('💸 Экономика · 2026-10 (UTC, с начала месяца)');
    expect(text).toContain('Расходы: $74.50');
    expect(text).toContain('· Инфраструктура $21.00 из $20.00 (105 %) ⛔');
    expect(text).toContain('· AI $41.00 из $50.00 (82 %) ⚠️ · сегодня $0.31 из $1.53');
    expect(text).toContain('· Реклама тестов $12.50');
    expect(text).toContain('⛔ Лимит D-007 превышен');
    expect(text).toContain('Тесты: 1 · потрачено $12.50 из одобренных $50.00');
    expect(text).toContain(
      'Выручка: оплаты $36.00 · предзаказы $40.00 · клиентов 5 · возвраты $12.00',
    );
    expect(text).toContain('Предзаказы — обязательство');
    expect(text).toContain('ROI системы: 32 %');
    expect(text).toContain('Проверенных гипотез: 2 · стоимость одной $6.25');
    expect(text).toContain('Источник: cost_entries, revenue_entries, ai_calls');
  });
});
