import { createCommandCenter } from '@roi-dealer/command-center';
import { createDatabase, createDatabaseHealthCheck, type Database } from '@roi-dealer/database';
import { createHealthRegistry, createLogger } from '@roi-dealer/observability';
import { createShutdownManager, exitProcess, installProcessHandlers } from '@roi-dealer/shared';
import {
  createLongPoller,
  createOwnerCommandRouter,
  createOwnerNotifier,
  createTelegramClient,
  toBotCommands,
} from '@roi-dealer/telegram';
import { createBotCommands, startedText, TEXT } from './commands.js';
import { loadBotConfig } from './config.js';

const SERVICE = 'bot';

/**
 * Container platforms send SIGKILL 10 s after SIGTERM by default, so the whole shutdown
 * (stop notification + polling stop) must fit well inside that window.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;
const TELEGRAM_REQUEST_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const config = loadBotConfig(process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

  const shutdown = createShutdownManager({ logger, timeoutMs: SHUTDOWN_TIMEOUT_MS });
  installProcessHandlers(shutdown, { logger });

  const client = createTelegramClient({
    token: config.TELEGRAM_BOT_TOKEN,
    baseUrl: config.TELEGRAM_API_BASE_URL,
    requestTimeoutMs: TELEGRAM_REQUEST_TIMEOUT_MS,
  });
  const me = await client.getMe();
  logger.info('telegram bot authenticated', { bot_id: me.id, bot_username: me.username });

  const ownerUserId = config.TELEGRAM_OWNER_USER_ID;
  const runtime = { version: config.APP_VERSION, environment: config.NODE_ENV };
  const health = createHealthRegistry({
    service: SERVICE,
    onCheckError: (check, error) => logger.warn('health check failed', { check, error }),
  });

  // The command center needs PostgreSQL; without DATABASE_URL its commands explain that.
  let database: Database | undefined;
  if (config.DATABASE_URL === undefined) {
    logger.info('database not configured');
  } else {
    const connected = createDatabase({
      url: config.DATABASE_URL,
      applicationName: 'roi-dealer-bot',
      maxConnections: config.DATABASE_POOL_MAX,
      connectTimeoutSeconds: config.DATABASE_CONNECT_TIMEOUT_SECONDS,
      logger,
    });
    database = connected;
    health.register(createDatabaseHealthCheck(connected));
    shutdown.register('database', () => connected.close());
  }
  const commandCenter = createCommandCenter({
    database,
    logger,
    deliverDigest: (text) => client.sendMessage({ chatId: ownerUserId, text }),
  });
  shutdown.register('daily-digest', () => commandCenter.stopDigest());

  const commands = createBotCommands({
    ...runtime,
    health,
    startedAt: Date.now(),
    panel: commandCenter.commands,
    statusLines: () => commandCenter.statusLines(),
  });

  try {
    // Commands appear in the Telegram menu only in the owner's chat.
    await client.setMyCommands({
      commands: toBotCommands(commands),
      scope: { type: 'chat', chat_id: ownerUserId },
    });
  } catch (error) {
    logger.warn('telegram command menu not updated', { error });
  }

  const poller = createLongPoller({
    client,
    logger,
    onUpdate: createOwnerCommandRouter({
      ownerUserId,
      commands,
      callbacks: commandCenter.callbacks,
      client,
      logger,
      ...(me.username === undefined ? {} : { botUsername: me.username }),
      unknownCommandReply: TEXT.unknownCommand,
      failureReply: TEXT.failure,
      unknownCallbackReply: TEXT.unknownButton,
    }),
    onFatalError: () => {
      void shutdown.shutdown('telegram token rejected', 1).then(exitProcess);
    },
  });
  const notifier = createOwnerNotifier({ client, ownerChatId: ownerUserId, logger });

  poller.start();
  shutdown.register('telegram-polling', () => poller.stop());
  shutdown.register('owner-notification', async () => {
    await notifier.notify(TEXT.stopped);
  });

  await notifier.notify(startedText(runtime));
  commandCenter.startDigest();
  logger.info('bot started', {
    node_env: config.NODE_ENV,
    version: config.APP_VERSION,
    database: database !== undefined,
  });
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('bot failed to start', { error });
  exitProcess(1);
});
