import type { Logger } from '@roi-dealer/observability';

export type WorkerState = 'idle' | 'running' | 'stopped';

export interface WorkerOptions {
  readonly logger: Logger;
  /** Interval of the liveness heartbeat log. Default: 60 000 ms. */
  readonly heartbeatIntervalMs?: number;
}

export interface Worker {
  readonly state: WorkerState;
  start(): void;
  /** Idempotent. Future phases stop Temporal workers and drain in-flight tasks here. */
  stop(): Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * PHASE 00 worker: lifecycle only. It executes no workflows or tasks;
 * the heartbeat keeps the process alive and proves liveness in logs.
 */
export function createWorker(options: WorkerOptions): Worker {
  const { logger } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let state: WorkerState = 'idle';
  let heartbeat: NodeJS.Timeout | undefined;

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== 'idle') throw new Error(`Cannot start worker in state "${state}"`);
      state = 'running';
      heartbeat = setInterval(() => logger.debug('worker heartbeat'), heartbeatIntervalMs);
      logger.info('worker started', { heartbeat_interval_ms: heartbeatIntervalMs });
    },
    stop() {
      if (state === 'stopped') return Promise.resolve();
      clearInterval(heartbeat);
      heartbeat = undefined;
      state = 'stopped';
      logger.info('worker stopped');
      return Promise.resolve();
    },
  };
}
