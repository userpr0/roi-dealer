import { z } from 'zod';
import { createLogger, LOG_LEVELS } from '@roi-dealer/observability';
import {
  createShutdownManager,
  exitProcess,
  installProcessHandlers,
  loadConfig,
  nodeEnvSchema,
} from '@roi-dealer/shared';
import { createWorker } from './worker.js';

const SERVICE = 'worker';

const workerConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
});

function main(): void {
  const config = loadConfig(workerConfigSchema, process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

  const shutdown = createShutdownManager({ logger });
  installProcessHandlers(shutdown, { logger });

  const worker = createWorker({ logger, heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS });
  worker.start();
  shutdown.register('worker', () => worker.stop());
}

try {
  main();
} catch (error) {
  createLogger({ service: SERVICE }).fatal('worker failed to start', { error });
  exitProcess(1);
}
