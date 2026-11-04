import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roiDigestLine, roiText } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  costEntryIdSchema,
  recordCostEntry,
  toTimestamp,
  usd,
  type Timestamp,
} from '@roi-dealer/domain';
import { processReport } from '@roi-dealer/economics';
import { createCtx, OWNER } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

// A month of its own, far from the other tests' data.
const NOW = Date.parse('2031-03-20T12:00:00Z');
const inMonth = (day: number): Timestamp => toTimestamp(new Date(Date.UTC(2031, 2, day, 9)));

let test: TestDatabase;
let db: Database;

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
});

afterAll(async () => {
  await test.drop();
});

async function aiCall(task: string, costMicroUsd: number, purpose: 'task' | 'eval' = 'task') {
  await db.aiCalls.record({
    occurredAt: inMonth(5),
    task,
    taskVersion: 1,
    purpose,
    provider: 'google',
    model: 'gemini-test',
    inputTokens: 100,
    outputTokens: 50,
    costMicroUsd,
    latencyMs: 10,
    outcome: 'ok',
    actorType: 'agent',
    actorId: 'pain-analyst',
  });
}

describe('ROI of the processes (16b)', () => {
  it('reads each process’s AI and ledger cost of the month and shows the verdicts in /roi', async () => {
    await aiCall('extract-signal', 2_500_000);
    await aiCall('write-landing', 1_500_000);
    await aiCall('extract-signal', 900_000, 'eval');
    // A call of another month never counts.
    await db.aiCalls.record({
      occurredAt: toTimestamp(new Date(Date.UTC(2031, 1, 27))),
      task: 'extract-signal',
      taskVersion: 1,
      purpose: 'task',
      provider: 'google',
      model: 'gemini-test',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 50_000_000,
      latencyMs: 1,
      outcome: 'ok',
      actorType: 'agent',
      actorId: 'pain-analyst',
    });
    await db.repositories.costEntries.insert(
      recordCostEntry(
        {
          category: 'infrastructure',
          amount: usd(500),
          description: 'Railway, March',
          incurredAt: inMonth(1),
          recurring: false,
          allocation: {},
        },
        createCtx(costEntryIdSchema, OWNER, 1),
      ),
    );

    const report = await processReport(db, NOW);
    expect(report.month).toBe('2031-03');
    expect(report.complete).toBe(false);
    const by = Object.fromEntries(report.lines.map((line) => [line.key, line]));
    expect(by['pains']).toMatchObject({ cost: usd(250), verdict: 'review' });
    expect(by['preparation']).toMatchObject({ cost: usd(150), verdict: 'review' });
    expect(by['quality']).toMatchObject({ cost: usd(90), verdict: 'shared' });
    expect(by['platform']).toMatchObject({ cost: usd(500), verdict: 'shared' });
    expect(report.totalCost).toEqual(usd(990));
    expect(report.roiPercent).toBe(0);

    const text = await roiText(db, NOW, '');
    expect(text).toContain('📊 ROI процессов · март 2031 (месяц идёт)');
    expect(text).toContain(
      '• Поиск болей: $2.50 · подтверждённые боли: 0 — 🔻 тратит без результата — пересмотреть или выключить',
    );
    expect(text).toContain('• Платформа: $5.00 — ℹ️ общие расходы');
    expect(text).toContain('Всего: расходы $9.90 · выручка $0.00 · ROI 0%');
    expect(text).toContain('Выключить агентов процесса — /access; всё сразу — /stop. Решаете вы.');
    // ADR-0015: paid calls of the batchable tasks (extract-signal), half of it saved by batches.
    expect(text).toContain(
      '🧺 Платные массовые вызовы AI: $2.50 · пакетный режим сэкономил бы ≈ $1.25 (строим от $10.00 в месяц, ADR-0015).',
    );
    expect(text.length).toBeLessThan(4_096);
  });

  it('shows the previous full month on request and points to it from the digest on the 1st', async () => {
    const april = Date.parse('2031-04-01T08:00:00Z');
    const previous = await roiText(db, april, 'прошлый');
    expect(previous).toContain('📊 ROI процессов · март 2031 (месяц закрыт)');
    expect(previous).toContain('• Поиск болей: $2.50');
    expect(previous).not.toContain('/roi прошлый');

    const current = await roiText(db, april, '');
    expect(current).toContain('апрель 2031 (месяц идёт)');
    expect(current).toContain('Всего: расходов нет');

    expect(roiDigestLine(april)).toBe('📊 Месяц закрыт: ROI процессов → /roi прошлый');
    expect(roiDigestLine(NOW)).toBeUndefined();
  });
});
