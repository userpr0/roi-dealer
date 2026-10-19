import { createDatabase, createDatabaseHealthCheck } from '@roi-dealer/database';
import { createHealthRegistry, createLogger } from '@roi-dealer/observability';
import { createShutdownManager, exitProcess, installProcessHandlers } from '@roi-dealer/shared';
import { previewPage } from '@roi-dealer/site';
import { loadApiConfig } from './config.js';
import { createPanelRoute } from './panel.js';
import { createRouter, type PanelRoute, type SiteRoutes } from './router.js';
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

  let panel: PanelRoute | undefined;
  let site: SiteRoutes | undefined;
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
    // Public pages of experiments (PHASE 19a): landing previews.
    site = { preview: (token) => previewPage(database, token) };
    // The Mini App's data (PHASE 13): only with the bot token to check Telegram's signature.
    if (config.TELEGRAM_BOT_TOKEN !== undefined && config.TELEGRAM_OWNER_USER_ID !== undefined) {
      panel = createPanelRoute({
        database,
        botToken: config.TELEGRAM_BOT_TOKEN,
        ownerUserId: config.TELEGRAM_OWNER_USER_ID,
        origins: config.MINIAPP_ORIGINS,
        logger,
      });
    }
  }
  logger.info('mini app panel', { enabled: panel !== undefined, origins: config.MINIAPP_ORIGINS });

  const server = await startApiServer({
    host: config.API_HOST,
    port: config.API_PORT,
    router: createRouter({ health, panel, site }),
    logger,
  });
  shutdown.register('http-server', () => server.close());

  logger.info('api started', { node_env: config.NODE_ENV });
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('api failed to start', { error });
  exitProcess(1);
});
