import { costEntryIdSchema, recordCostEntry, toTimestamp, usd } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import { AI_RUNTIME_ACTOR } from './runtime.js';

const DAY_MS = 24 * 3_600_000;
const MICRO_PER_CENT = 10_000;

/** `YYYY-MM-DD` of the UTC day before `nowMs`. */
export function previousUtcDate(nowMs: number): string {
  return new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Records the AI spend of one UTC day as a `CostEntry` of category `ai` (§2.8), once per day:
 * the command key is `ai-cost-<date>`. Rounded up to a cent; a day without spend records
 * nothing. The daily limit keeps the amount under the approval threshold (D-006).
 */
export async function recordDailyAiCost(
  database: Database,
  date: string,
  nowMs: number,
): Promise<'recorded' | 'nothing_spent' | 'already_recorded'> {
  const from = Date.parse(`${date}T00:00:00.000Z`);
  const spend = await database.aiCalls.spend({
    from: toTimestamp(new Date(from)),
    to: toTimestamp(new Date(from + DAY_MS)),
  });
  const cents = Math.ceil(spend.costMicroUsd / MICRO_PER_CENT);
  if (cents === 0) return 'nothing_spent';

  const { outcome } = await database.command(
    { name: 'ai.daily_cost', idempotencyKey: `ai-cost-${date}`, correlationId: `ai-cost-${date}` },
    async ({ repositories }) => {
      await repositories.costEntries.insert(
        recordCostEntry(
          {
            category: 'ai',
            amount: usd(cents),
            description: `AI за ${date} (UTC): вызовов ${String(spend.calls)}, из них с ошибкой ${String(spend.failed)}`,
            incurredAt: toTimestamp(new Date(from + DAY_MS - 1)),
            recurring: false,
            allocation: {},
          },
          {
            id: costEntryIdSchema.parse(uuidv7()),
            actor: AI_RUNTIME_ACTOR,
            at: toTimestamp(new Date(nowMs)),
          },
        ),
      );
      return cents;
    },
  );
  return outcome === 'executed' ? 'recorded' : 'already_recorded';
}
