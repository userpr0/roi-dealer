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
  const commands = createBotCommands({ ...runtime, health, startedAt: Date.now() });

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
      client,
      logger,
      ...(me.username === undefined ? {} : { botUsername: me.username }),
      unknownCommandReply: TEXT.unknownCommand,
      failureReply: TEXT.failure,
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
  logger.info('bot started', { node_env: config.NODE_ENV, version: config.APP_VERSION });
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('bot failed to start', { error });
  exitProcess(1);
});
