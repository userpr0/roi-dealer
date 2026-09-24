import { createHealthRegistry, createLogger } from '@roi-dealer/observability';
import { createShutdownManager, exitProcess, installProcessHandlers } from '@roi-dealer/shared';
import { loadApiConfig } from './config.js';
import { createRouter } from './router.js';
import { startApiServer } from './server.js';

const SERVICE = 'api';

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

  const shutdown = createShutdownManager({ logger });
  installProcessHandlers(shutdown, { logger });

  // PHASE 00: no dependency checks yet. Database, Temporal, storage and AI provider
  // checks are registered here by the phases that introduce those dependencies.
  const health = createHealthRegistry({
    service: SERVICE,
    onCheckError: (check, error) => logger.warn('health check failed', { check, error }),
  });

  const server = await startApiServer({
    host: config.API_HOST,
    port: config.API_PORT,
    router: createRouter({ health }),
    logger,
  });
  shutdown.register('http-server', () => server.close());

  logger.info('api started', { node_env: config.NODE_ENV });
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('api failed to start', { error });
  exitProcess(1);
});
