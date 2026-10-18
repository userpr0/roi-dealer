import { ensureAccessRequest } from '@roi-dealer/command-center';
import { createDatabase } from '@roi-dealer/database';
import { createEvidenceScheduler, createHackerNewsConnector } from '@roi-dealer/evidence';
import { createLogger } from '@roi-dealer/observability';
import { createShutdownManager, exitProcess, installProcessHandlers } from '@roi-dealer/shared';
import { loadWorkerConfig } from './config.js';
import { createWorker } from './worker.js';

const SERVICE = 'worker';

function main(): void {
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

  const shutdown = createShutdownManager({ logger });
  installProcessHandlers(shutdown, { logger });

  const worker = createWorker({ logger, heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS });
  worker.start();
  shutdown.register('worker', () => worker.stop());

  // Evidence collection (PHASE 05) needs PostgreSQL: the catalog, grants and evidence live there.
  if (config.DATABASE_URL === undefined) {
    logger.info('database not configured: evidence collection is off');
    return;
  }
  const database = createDatabase({
    url: config.DATABASE_URL,
    applicationName: 'roi-dealer-worker',
    maxConnections: config.DATABASE_POOL_MAX,
    connectTimeoutSeconds: config.DATABASE_CONNECT_TIMEOUT_SECONDS,
    logger,
  });
  shutdown.register('database', () => database.close());

  const evidence = createEvidenceScheduler({
    database,
    logger,
    connectors: [createHackerNewsConnector({ baseUrl: config.HACKER_NEWS_API_URL })],
    ensureAccess: ensureAccessRequest,
    intervalMs: config.EVIDENCE_COLLECT_INTERVAL_MS,
  });
  evidence.start();
  // Registered last, so it stops first: loads finish before the database closes.
  shutdown.register('evidence-collection', () => evidence.stop());
}

try {
  main();
} catch (error) {
  createLogger({ service: SERVICE }).fatal('worker failed to start', { error });
  exitProcess(1);
}
