import { createDatabase, createDatabaseHealthCheck } from '@roi-dealer/database';
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

  // Dependency checks are registered by the phases that introduce the dependency:
  // database (PHASE 02); Temporal, storage and AI providers later.
  const health = createHealthRegistry({
    service: SERVICE,
    onCheckError: (check, error) => logger.warn('health check failed', { check, error }),
  });

  if (config.DATABASE_URL === undefined) {
    logger.info('database not configured');
  } else {
    const database = createDatabase({
      url: config.DATABASE_URL,
      applicationName: 'roi-dealer-api',
      maxConnections: config.DATABASE_POOL_MAX,
      connectTimeoutSeconds: config.DATABASE_CONNECT_TIMEOUT_SECONDS,
      logger,
    });
    health.register(createDatabaseHealthCheck(database));
    shutdown.register('database', () => database.close());
  }

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
