import { z } from 'zod';

export const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/** Token issued by @BotFather, e.g. `123456789:AA…`. The value never appears in validation errors. */
export const telegramBotTokenSchema = z
  .string()
  .regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'expected a bot token issued by @BotFather');

/** Numeric Telegram user id (see @userinfobot). */
export const telegramUserIdSchema = z.coerce.number().int().positive();

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Bot API base URL. The bot token travels in the request path, so plain HTTP
 * is accepted only for loopback addresses (local Bot API server, tests).
 */
export const telegramApiBaseUrlSchema = z
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
      );
    },
    { error: 'must use https (http is allowed only for localhost)' },
  )
  .transform((value) => value.replace(/\/+$/, ''));
