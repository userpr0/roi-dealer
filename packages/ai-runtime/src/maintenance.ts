import type { Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { previousUtcDate, recordDailyAiCost } from './daily-cost.js';
import type { AiRuntime } from './runtime.js';
import type { AnyAiTask } from './task.js';

export interface AiMaintenanceOptions {
  readonly runtime: AiRuntime;
  readonly database: Database;
  readonly logger: Logger;
  readonly tasks: readonly AnyAiTask[];
  /** Default: one hour. */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

export interface AiMaintenance {
  start(): void;
  /** One round now: model list, missing evals, yesterday's cost entry. */
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

const HOUR_MS = 3_600_000;
const MODEL_CHECK_MS = 24 * HOUR_MS;

/**
 * Keeps the runtime usable without the owner's attention: confirms models with the providers
 * (at start and daily), evaluates tasks that have no report for their version, and records
 * yesterday's AI spend as a CostEntry. Never overlaps itself.
 */
export function createAiMaintenance(options: AiMaintenanceOptions): AiMaintenance {
  const { runtime, database, logger } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? HOUR_MS;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let modelsCheckedAt: number | undefined;

  async function runOnce(): Promise<void> {
    try {
      if (modelsCheckedAt === undefined || now() - modelsCheckedAt >= MODEL_CHECK_MS) {
        await runtime.verifyModels();
        modelsCheckedAt = now();
      }
      await runtime.evaluateMissing(options.tasks);
      const date = previousUtcDate(now());
      const recorded = await recordDailyAiCost(database, date, now());
      if (recorded === 'recorded') logger.info('ai daily cost recorded', { date });
    } catch (error) {
      logger.error('ai maintenance failed', { error });
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = runOnce().finally(() => {
        running = undefined;
        schedule(intervalMs);
      });
    }, delayMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    runOnce,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
