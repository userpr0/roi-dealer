import { DomainError, toTimestamp } from '@roi-dealer/domain';
import type { EnsureAccess } from '@roi-dealer/signals';
import {
  assessPains,
  assertOpportunitiesRunning,
  OPPORTUNITY_ANALYST_ACCESS,
  type OpportunitiesDeps,
} from './assess.js';

export interface OpportunitiesSchedulerOptions extends OpportunitiesDeps {
  readonly ensureAccess: EnsureAccess;
  readonly intervalMs: number;
  /** Pains per run; default 5. */
  readonly batchSize?: number;
}

export interface OpportunitiesScheduler {
  start(): void;
  /** One run now: kill switch, access request, assessment. */
  runOnce(): Promise<void>;
  /** Cancels the timer, aborts AI calls in flight and waits for the run. */
  stop(): Promise<void>;
}

/**
 * Runs the opportunity analyst every `intervalMs` (and right after start), never twice at once.
 * The first run asks the owner for the agent's access; until it is granted nothing is assessed.
 */
export function createOpportunitiesScheduler(
  options: OpportunitiesSchedulerOptions,
): OpportunitiesScheduler {
  const { database, logger } = options;
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let abort = new AbortController();

  async function runOnce(): Promise<void> {
    try {
      await assertOpportunitiesRunning(database);
      const access = await options.ensureAccess(database, OPPORTUNITY_ANALYST_ACCESS, {
        at: toTimestamp(new Date(now())),
        correlationId: 'opportunities-connect-analyst',
      });
      const outcome = await assessPains(options, {
        batchSize: options.batchSize,
        signal: abort.signal,
      });
      if (outcome.status === 'skipped') {
        logger.info('opportunity assessment skipped', {
          reason: outcome.reason,
          access: access.state,
        });
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'automation_paused') {
        logger.info('opportunity assessment paused by the kill switch');
        return;
      }
      logger.error(
        'opportunity assessment failed',
        error instanceof DomainError ? { code: error.code } : { error },
      );
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = runOnce().finally(() => {
        running = undefined;
        schedule(options.intervalMs);
      });
    }, delayMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      schedule(0);
      logger.info('opportunity assessment scheduled', { interval_ms: options.intervalMs });
    },
    runOnce,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      await running;
    },
  };
}
