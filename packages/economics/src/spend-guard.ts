import {
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  spendAnomaly,
  SPEND_ANOMALY_DAYS,
  toTimestamp,
  type Actor,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';

/** The system identity that pulls the kill switch on a spend anomaly (D-014 п.10). */
export const SPEND_GUARD: Actor = { type: 'system', id: 'spend-guard' };
/** Every automatic pause reason starts with this; the bot tells the owner once per pause. */
export const AUTO_PAUSE_PREFIX = 'Автопауза';

const MINUTE_MS = 60_000;

export type SpendGuardOutcome = 'normal' | 'paused' | 'already_paused';

export interface SpendGuardResult {
  readonly outcome: SpendGuardOutcome;
  readonly todayMicroUsd: number;
  readonly thresholdMicroUsd: number;
}

const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/**
 * One check of D-014 п.10: today's automated spend (AI calls and costs the system recorded)
 * against twice the average of the previous seven days, never below the floor. An anomaly
 * pulls the kill switch as `system:spend-guard`; only the owner resumes. A paused system is
 * left as it is — the guard is an automation itself.
 */
export async function runSpendGuard(database: Database, nowMs: number): Promise<SpendGuardResult> {
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined)
    throw new Error('the automation kill switch is missing (migration 0003)');
  const days = await database.economics.automatedSpendByDay({
    days: SPEND_ANOMALY_DAYS + 1,
    until: nowMs,
  });
  const todayMicroUsd = days.at(-1) ?? 0;
  const check = spendAnomaly(todayMicroUsd, days.slice(0, -1));
  const result = { todayMicroUsd, thresholdMicroUsd: check.thresholdMicroUsd };
  if (control.status === 'paused') return { ...result, outcome: 'already_paused' };
  if (!check.anomalous) return { ...result, outcome: 'normal' };

  const at = toTimestamp(new Date(nowMs));
  const reason =
    `${AUTO_PAUSE_PREFIX}: автоматика потратила сегодня ${dollars(todayMicroUsd)} — не меньше ` +
    `${dollars(check.thresholdMicroUsd)} (вдвое выше среднего за ${String(SPEND_ANOMALY_DAYS)} ` +
    `дней, ${dollars(check.averageMicroUsd)}). Проверьте /economics и /agents; возобновить — /resume.`;
  try {
    await database.transaction(
      (scope) =>
        scope.repositories.systemControls.update(
          pauseSystem(control, reason, { actor: SPEND_GUARD, at }),
          SPEND_GUARD,
        ),
      { correlationId: `spend-guard-${at.slice(0, 10)}` },
    );
  } catch (error) {
    // The owner pulled the switch at the same moment.
    if (error instanceof ConcurrencyError) return { ...result, outcome: 'already_paused' };
    throw error;
  }
  return { ...result, outcome: 'paused' };
}

export interface SpendGuardOptions {
  readonly database: Database;
  readonly logger: Logger;
  /** Default: 15 minutes. */
  readonly intervalMs?: number | undefined;
  readonly now?: () => number;
}

export interface SpendGuard {
  start(): void;
  runOnce(): Promise<SpendGuardResult | undefined>;
  stop(): Promise<void>;
}

/** Runs the spend guard on an interval in the worker; never overlaps itself. */
export function createSpendGuard(options: SpendGuardOptions): SpendGuard {
  const { database, logger } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 15 * MINUTE_MS;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;

  async function runOnce(): Promise<SpendGuardResult | undefined> {
    try {
      const result = await runSpendGuard(database, now());
      if (result.outcome === 'paused') {
        logger.warn('spend anomaly: automation paused', {
          today_micro_usd: result.todayMicroUsd,
          threshold_micro_usd: result.thresholdMicroUsd,
        });
      }
      return result;
    } catch (error) {
      logger.error('spend guard failed', { error });
      return undefined;
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
