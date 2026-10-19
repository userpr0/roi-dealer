import { z } from 'zod';
import { databaseConfigShape } from '@roi-dealer/database';
import { LOG_LEVELS } from '@roi-dealer/observability';
import { loadConfig, nodeEnvSchema, portSchema, type EnvSource } from '@roi-dealer/shared';
import { telegramBotTokenSchema, telegramUserIdSchema } from '@roi-dealer/telegram';

/** The Mini App on GitHub Pages (ADR-0002); several origins are separated by commas. */
export const DEFAULT_MINIAPP_ORIGINS = 'https://userpr0.github.io';

const originsSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  )
  .pipe(
    z
      .array(
        z.url().refine((value) => /^https:\/\/[^/]+$/.test(value), {
          error: 'an origin is https://host without a path',
        }),
      )
      .min(1),
  );

const apiConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Loopback by default; bind to 0.0.0.0 explicitly when running inside a container. */
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: portSchema.default(3000),
  /** Optional until the first API endpoint needs data: when set, `/health` checks the database. */
  DATABASE_URL: databaseConfigShape.DATABASE_URL.optional(),
  DATABASE_POOL_MAX: databaseConfigShape.DATABASE_POOL_MAX,
  DATABASE_CONNECT_TIMEOUT_SECONDS: databaseConfigShape.DATABASE_CONNECT_TIMEOUT_SECONDS,
  /**
   * The bot's token, used only to check the Mini App's Telegram signature (PHASE 13, ADR-0008).
   * With it, the owner's id and the database, `GET /api/panel` serves the Mini App.
   */
  TELEGRAM_BOT_TOKEN: telegramBotTokenSchema.optional(),
  TELEGRAM_OWNER_USER_ID: telegramUserIdSchema.optional(),
  MINIAPP_ORIGINS: originsSchema.default([DEFAULT_MINIAPP_ORIGINS]),
  /**
   * Where people ask to delete their data (PHASE 20): shown on `/privacy` and after a sign-up.
   * Without it test pages have no sign-up form.
   */
  PUBLIC_CONTACT_EMAIL: z.email().max(254).optional(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(env: EnvSource): ApiConfig {
  return loadConfig(apiConfigSchema, env);
}
