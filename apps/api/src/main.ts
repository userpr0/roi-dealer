import { ensureAccessRequest } from '@roi-dealer/command-center';
import { createDatabase, createDatabaseHealthCheck, type Database } from '@roi-dealer/database';
import { toTimestamp, type NewPrincipal } from '@roi-dealer/domain';
import { handleLemonSqueezyWebhook, PAYMENTS_ACCESS } from '@roi-dealer/payments';
import { createHealthRegistry, createLogger, type Logger } from '@roi-dealer/observability';
import { createShutdownManager, exitProcess, installProcessHandlers } from '@roi-dealer/shared';
import {
  createSiteTracker,
  createSubmissionLimiter,
  landingPage,
  previewPage,
  privacyPage,
  SITE_ACCESS,
} from '@roi-dealer/site';
import { loadApiConfig } from './config.js';
import { createPanelRoute } from './panel.js';
import { createRouter, type PanelRoute, type PaymentRoutes, type SiteRoutes } from './router.js';
import { startApiServer } from './server.js';

const SERVICE = 'api';
/** How often the page counter's access request is renewed while the owner has not decided. */
const SITE_ACCESS_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * An integration of the api asks the owner for access in /decisions: the page counter (PHASE
 * 21), the payment provider (PHASE 20b). Never throws.
 */
async function requestAccess(
  database: Database,
  logger: Logger,
  access: NewPrincipal,
  name: string,
): Promise<void> {
  try {
    const { state } = await ensureAccessRequest(database, access, {
      at: toTimestamp(new Date()),
      correlationId: `${access.actor.id}-connect`,
    });
    logger.info(`${name} access`, { state });
  } catch (error) {
    logger.warn(`${name} access not requested`, { error });
  }
}

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
  let payments: PaymentRoutes | undefined;
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
    // Pages of experiments: previews (PHASE 19a), released landings (PHASE 21), sign-ups (PHASE 20).
    const tracker = createSiteTracker({ database, logger });
    const contactEmail = config.PUBLIC_CONTACT_EMAIL;
    const pages = {
      database,
      tracker,
      logger,
      contactEmail,
      limiter: createSubmissionLimiter(),
    };
    site = {
      preview: (token) => previewPage(database, token, { contactEmail }),
      landing: (slug, step, visit, form) => landingPage(pages, slug, step, visit, form),
      privacy: () => privacyPage(contactEmail),
    };
    logger.info('sign-up form', { enabled: contactEmail !== undefined });
    // Payments through the merchant of record (PHASE 20b, ADR-0009): only with the secret.
    const secret = config.LEMONSQUEEZY_WEBHOOK_SECRET;
    if (secret !== undefined) {
      payments = {
        lemonsqueezy: (body, signature, correlationId) =>
          handleLemonSqueezyWebhook(
            { database, logger },
            { body, signature, secret, correlationId },
          ),
      };
    }
    logger.info('payment webhook', { enabled: payments !== undefined });
    const connect = (): void => {
      void requestAccess(database, logger, SITE_ACCESS, 'page counter');
      if (payments !== undefined) void requestAccess(database, logger, PAYMENTS_ACCESS, 'payments');
    };
    // In the background: the api serves pages even while the database is slow to answer.
    connect();
    const renewal = setInterval(connect, SITE_ACCESS_INTERVAL_MS);
    renewal.unref();
    shutdown.register('site-access', () => {
      clearInterval(renewal);
      return Promise.resolve();
    });
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
    router: createRouter({ health, panel, site, payments }),
    logger,
  });
  shutdown.register('http-server', () => server.close());

  logger.info('api started', { node_env: config.NODE_ENV });
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('api failed to start', { error });
  exitProcess(1);
});
