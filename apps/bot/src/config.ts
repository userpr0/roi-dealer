import { z } from 'zod';
import { LOG_LEVELS } from '@roi-dealer/observability';
import { loadConfig, nodeEnvSchema, type EnvSource } from '@roi-dealer/shared';
import {
  DEFAULT_TELEGRAM_API_BASE_URL,
  telegramApiBaseUrlSchema,
  telegramBotTokenSchema,
  telegramUserIdSchema,
} from '@roi-dealer/telegram';

const botConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Shown in /status; set to the git commit SHA at deploy time. */
  APP_VERSION: z.string().min(1).max(64).default('dev'),
  TELEGRAM_BOT_TOKEN: telegramBotTokenSchema,
  /** The only Telegram user the bot answers to. */
  TELEGRAM_OWNER_USER_ID: telegramUserIdSchema,
  TELEGRAM_API_BASE_URL: telegramApiBaseUrlSchema.default(DEFAULT_TELEGRAM_API_BASE_URL),
});

export type BotConfig = z.infer<typeof botConfigSchema>;

export function loadBotConfig(env: EnvSource): BotConfig {
  return loadConfig(botConfigSchema, env);
}
