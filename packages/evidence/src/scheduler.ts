import { DomainError } from '@roi-dealer/domain';
import type { Logger } from '@roi-dealer/observability';
import { findCatalogEntry, SOURCE_CATALOG } from './catalog.js';
import {
  collectEvidence,
  ensureConnection,
  type CollectOutcome,
  type EngineDeps,
  type EnsureAccess,
} from './collect.js';
import type { SourceConnector } from './connector.js';
import { EvidenceEngineError } from './errors.js';

export interface EvidenceSchedulerOptions extends EngineDeps {
  readonly connectors: readonly SourceConnector[];
  readonly ensureAccess: EnsureAccess;
  /** How often the scheduler wakes up; each source is still loaded at most once per its catalog interval. */
  readonly intervalMs: number;
}

export interface EvidenceScheduler {
  start(): void;
  /** Runs every connector once now (also used by `start`). */
  runOnce(): Promise<void>;
  /** Cancels the timer, aborts loads in flight and waits for them. */
  stop(): Promise<void>;
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof EvidenceEngineError || error instanceof DomainError) {
    return { code: error.code, details: error.details };
  }
  return { error };
}

/**
 * Wakes up every `intervalMs` (and right after start): for each connector it sets up the
 * connection (source record, access request) and loads new items, never two runs at once.
 * The kill switch, a refused catalog entry or a missing grant stop a connector, not the worker.
 */
export function createEvidenceScheduler(options: EvidenceSchedulerOptions): EvidenceScheduler {
  const { logger } = options;
  const now = options.now ?? Date.now;
  const lastRun = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let stopping = false;
  let abort = new AbortController();

  async function runConnector(connector: SourceConnector): Promise<void> {
    const entry = findCatalogEntry(connector.catalogKey, options.catalog ?? SOURCE_CATALOG);
    const minIntervalMs = (entry?.limits.minIntervalMinutes ?? 0) * 60_000;
    const previous = lastRun.get(connector.catalogKey);
    if (previous !== undefined && now() - previous < minIntervalMs) return;

    const log: Logger = logger.child({ catalog_key: connector.catalogKey });
    try {
      const connection = await ensureConnection(connector.catalogKey, options);
      const outcome: CollectOutcome = await collectEvidence(connector, {
        ...options,
        signal: abort.signal,
      });
      // The interval limits requests to the source: a run without a request does not count.
      if (outcome.status === 'collected' || outcome.reason === 'nothing_new') {
        lastRun.set(connector.catalogKey, now());
      }
      if (outcome.status === 'skipped') {
        log.info('evidence collection skipped', {
          reason: outcome.reason,
          access: connection.access,
        });
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'automation_paused') {
        log.info('evidence collection paused by the kill switch');
        return;
      }
      lastRun.set(connector.catalogKey, now());
      log.error('evidence collection failed', errorFields(error));
    }
  }

  async function runOnce(): Promise<void> {
    for (const connector of options.connectors) {
      if (stopping) return;
      await runConnector(connector);
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
      stopping = false;
      abort = new AbortController();
      schedule(0);
      logger.info('evidence collection scheduled', {
        interval_ms: options.intervalMs,
        sources: options.connectors.map((connector) => connector.catalogKey),
      });
    },
    runOnce,
    async stop() {
      stopped = true;
      stopping = true;
      clearTimeout(timer);
      abort.abort();
      await running;
    },
  };
}
