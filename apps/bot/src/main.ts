import { z } from 'zod';
import { createLogger, LOG_LEVELS } from '@roi-dealer/observability';
import { exitProcess, loadConfig } from '@roi-dealer/shared';

const SERVICE = 'bot';

const botConfigSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/**
 * PHASE 00 skeleton. The Telegram connection is intentionally absent:
 * no bot token is read, no network calls are made.
 */
try {
  const config = loadConfig(botConfigSchema, process.env);
  createLogger({ service: SERVICE, level: config.LOG_LEVEL }).info(
    'bot skeleton: Telegram integration is not implemented in PHASE 00',
  );
} catch (error) {
  createLogger({ service: SERVICE }).fatal('bot failed to start', { error });
  exitProcess(1);
}
