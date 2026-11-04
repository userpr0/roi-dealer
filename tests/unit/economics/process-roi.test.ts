import { describe, expect, it } from 'vitest';
import type { ProcessOutputs } from '@roi-dealer/database';
import { usd, type CostCategory, type Money } from '@roi-dealer/domain';
import { PROCESSES, processRoi } from '@roi-dealer/economics';

const NONE: ProcessOutputs = {
  aiByTask: new Map(),
  aiEvalMicroUsd: 0,
  signals: 0,
  painsValidated: 0,
  opportunitiesApproved: 0,
  hypotheses: 0,
  landingsApproved: 0,
  leads: 0,
};

function run(
  outputs: Partial<ProcessOutputs>,
  costs: [CostCategory, Money][] = [],
  revenue = usd(0),
) {
  const lines = processRoi({
    costs: new Map(costs),
    outputs: { ...NONE, ...outputs },
    revenue,
  });
  return Object.fromEntries(lines.map((line) => [line.key, line]));
}

describe('processRoi (16b, §2.13)', () => {
  it('weighs each process’s AI and ledger cost against its own result', () => {
    const lines = run(
      {
        // $3.00 of pain-finding AI, $0.60 of opportunity AI, $0.40 of evals.
        aiByTask: new Map([
          ['extract-signal', 2_000_000],
          ['match-pain', 1_000_000],
          ['judge-opportunity', 600_000],
        ]),
        aiEvalMicroUsd: 400_000,
        painsValidated: 4,
        opportunitiesApproved: 0,
      },
      [['infrastructure', usd(500)]],
    );
    expect(lines['pains']).toMatchObject({
      cost: usd(300),
      output: { label: 'подтверждённые боли', count: 4 },
      unitCost: usd(75),
      verdict: 'keep',
    });
    // Under a dollar: too early to judge, even without a result.
    expect(lines['opportunities']).toMatchObject({ cost: usd(60), verdict: 'early' });
    expect(lines['quality']).toMatchObject({ cost: usd(40), verdict: 'shared' });
    expect(lines['platform']).toMatchObject({ cost: usd(500), verdict: 'shared' });
  });

  it('flags a process that spends without a result, and scales tests that pay back', () => {
    expect(run({ aiByTask: new Map([['write-landing', 2_500_000]]) })['preparation']).toMatchObject(
      { cost: usd(250), verdict: 'review' },
    );
    const paying = run({ leads: 3 }, [['ads', usd(4_000)]], usd(6_000))['tests'];
    expect(paying).toMatchObject({
      cost: usd(4_000),
      unitCost: usd(1_333),
      revenue: usd(6_000),
      verdict: 'scale',
    });
    expect(run({ leads: 2 }, [['ads', usd(4_000)]])['tests']?.verdict).toBe('keep');
    expect(run({}, [['ads', usd(4_000)]])['tests']?.verdict).toBe('review');
  });

  it('puts unnamed AI tasks and infrastructure into the platform, flagged over the D-007 limit', () => {
    const lines = run({ aiByTask: new Map([['new-task', 1_000_000]]) }, [
      ['infrastructure', usd(2_500)],
      ['ai', usd(9_999)],
      ['refund', usd(9_999)],
    ]);
    // The AI ledger entries repeat the call journal; refunds are not costs.
    expect(lines['platform']).toMatchObject({ cost: usd(2_600), verdict: 'over_limit' });
    const total = Object.values(lines).reduce((sum, line) => sum + line.cost.amountCents, 0);
    expect(total).toBe(2_600);
  });

  it('names every AI task in at most one process', () => {
    const tasks = PROCESSES.flatMap((process) => process.aiTasks);
    expect(new Set(tasks).size).toBe(tasks.length);
  });
});

describe('batch mode threshold (ADR-0015)', () => {
  it('says when paid batchable calls pass $10 a month', async () => {
    const { batchLine } = await import('@roi-dealer/command-center');
    expect(batchLine(12_000_000)).toContain('порог $10.00 пройден');
    expect(batchLine(0)).toContain('$0.00');
  });
});
