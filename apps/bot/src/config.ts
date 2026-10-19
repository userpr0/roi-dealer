import { z } from 'zod';
import { databaseConfigShape } from '@roi-dealer/database';
import { LOG_LEVELS } from '@roi-dealer/observability';
import { loadConfig, nodeEnvSchema, type EnvSource } from '@roi-dealer/shared';
import {
  DEFAULT_TELEGRAM_API_BASE_URL,
  telegramApiBaseUrlSchema,
  telegramBotTokenSchema,
  telegramUserIdSchema,
  type MenuButton,
} from '@roi-dealer/telegram';

export const DEFAULT_MINIAPP_URL = 'https://userpr0.github.io/roi-dealer/';

/** An https address with a plain DNS host name (http only for localhost). */
function isPublicAddress(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const local =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  return (url.protocol === 'https:' || local) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(url.hostname);
}

const botConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Shown in /status; set to the git commit SHA at deploy time. */
  APP_VERSION: z.string().min(1).max(64).default('dev'),
  TELEGRAM_BOT_TOKEN: telegramBotTokenSchema,
  /** The only Telegram user the bot answers to. */
  TELEGRAM_OWNER_USER_ID: telegramUserIdSchema,
  TELEGRAM_API_BASE_URL: telegramApiBaseUrlSchema.default(DEFAULT_TELEGRAM_API_BASE_URL),
  /** Optional: without it the bot runs, and the command center explains that there is no database. */
  DATABASE_URL: databaseConfigShape.DATABASE_URL.optional(),
  DATABASE_POOL_MAX: databaseConfigShape.DATABASE_POOL_MAX,
  DATABASE_CONNECT_TIMEOUT_SECONDS: databaseConfigShape.DATABASE_CONNECT_TIMEOUT_SECONDS,
  /**
   * The public address of the api service, for the preview links of landings (PHASE 19a) and the
   * owner's menu button (ADR-0008). Optional: without it a landing card shows the text only. An
   * invalid value — e.g. a reference to an api without a domain yet — counts as not set, so the
   * bot, which holds the kill switch, keeps running.
   */
  PUBLIC_API_URL: z
    .url()
    .refine(isPublicAddress, { error: 'an https address (http only for localhost)' })
    .optional()
    .catch(undefined),
  /**
   * The Mini App's address (GitHub Pages, ADR-0002). With `PUBLIC_API_URL` the bot sets the
   * owner's menu button to it, with the api address as `?api=` (ADR-0008).
   */
  MINIAPP_URL: z
    .url()
    .refine((value) => value.startsWith('https://'), { error: 'an https address' })
    .default(DEFAULT_MINIAPP_URL),
  /** How often the bot looks for opportunities to send for a decision (PHASE 12). Default: 5 min. */
  DECISION_CARDS_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(5 * 60_000),
});

export type BotConfig = z.infer<typeof botConfigSchema>;

export function loadBotConfig(env: EnvSource): BotConfig {
  return loadConfig(botConfigSchema, env);
}

/**
 * The owner's menu button «Пульт»: the Mini App with the api's address as `?api=`, so the
 * Mini App needs no build-time variable. Without `PUBLIC_API_URL` the menu stays as it is.
 */
export function panelMenuButton(
  config: Pick<BotConfig, 'MINIAPP_URL' | 'PUBLIC_API_URL'>,
): MenuButton | undefined {
  if (config.PUBLIC_API_URL === undefined) return undefined;
  const url = new URL(config.MINIAPP_URL);
  url.searchParams.set('api', config.PUBLIC_API_URL.replace(/\/+$/, ''));
  return { type: 'web_app', text: 'Пульт', web_app: { url: url.href } };
}
