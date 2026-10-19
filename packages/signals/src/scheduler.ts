import {
  DomainError,
  toTimestamp,
  type NewPrincipal,
  type Principal,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import {
  analyzeEvidence,
  assertSignalsRunning,
  PAIN_ANALYST_ACCESS,
  type SignalsDeps,
} from './analyze.js';

/** Asks the owner for an agent's access; `ensureAccessRequest` of the command center. */
export type EnsureAccess = (
  database: Database,
  data: NewPrincipal,
  options: { readonly at: Timestamp; readonly correlationId?: string | undefined },
) => Promise<{ readonly state: string; readonly principal: Principal }>;

export interface SignalsSchedulerOptions extends SignalsDeps {
  readonly ensureAccess: EnsureAccess;
  readonly intervalMs: number;
  /** Evidence per run; default 20. */
  readonly batchSize?: number;
}

export interface SignalsScheduler {
  start(): void;
  /** One run now: kill switch, access request, analysis. */
  runOnce(): Promise<void>;
  /** Cancels the timer, aborts AI calls in flight and waits for the run. */
  stop(): Promise<void>;
}

/**
 * Runs the pain analyst every `intervalMs` (and right after start), never twice at once. The
 * first run asks the owner for the agent's access; until it is granted nothing is analyzed.
 */
export function createSignalsScheduler(options: SignalsSchedulerOptions): SignalsScheduler {
  const { database, logger } = options;
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let abort = new AbortController();

  async function runOnce(): Promise<void> {
    try {
      await assertSignalsRunning(database);
      const access = await options.ensureAccess(database, PAIN_ANALYST_ACCESS, {
        at: toTimestamp(new Date(now())),
        correlationId: 'signals-connect-pain-analyst',
      });
      const outcome = await analyzeEvidence(options, {
        batchSize: options.batchSize,
        signal: abort.signal,
      });
      if (outcome.status === 'skipped') {
        logger.info('pain analysis skipped', { reason: outcome.reason, access: access.state });
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'automation_paused') {
        logger.info('pain analysis paused by the kill switch');
        return;
      }
      logger.error(
        'pain analysis failed',
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
      logger.info('pain analysis scheduled', { interval_ms: options.intervalMs });
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
