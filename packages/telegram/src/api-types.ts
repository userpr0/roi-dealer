import { z } from 'zod';

/**
 * Subset of Telegram Bot API objects used by ROI Dealer.
 * Unknown fields are stripped; only what the code reads is validated.
 * See https://core.telegram.org/bots/api#available-types
 */

export const telegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  username: z.string().optional(),
});
export type TelegramUser = z.infer<typeof telegramUserSchema>;

export const telegramChatSchema = z.object({
  id: z.number().int(),
  /** `private`, `group`, `supergroup`, `channel` — kept as string to tolerate future types. */
  type: z.string(),
});
export type TelegramChat = z.infer<typeof telegramChatSchema>;

export const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: telegramChatSchema,
  from: telegramUserSchema.optional(),
  text: z.string().optional(),
});
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

/**
 * `callback_data` of an inline button: `<prefix>:<data>`, at most 64 bytes (Bot API limit).
 * Only ASCII letters, digits and `:_-`, so button data is safe to log and to parse.
 */
export const CALLBACK_DATA_PATTERN = /^[a-z]{1,8}:[A-Za-z0-9:_-]{0,55}$/;

/** A pressed inline button. `message` is absent when the message is too old to be shown. */
export const telegramCallbackQuerySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  from: telegramUserSchema,
  message: telegramMessageSchema.optional().catch(undefined),
  /** Absent for game buttons; anything not in our format is treated as unknown. */
  data: z.string().optional(),
});
export type TelegramCallbackQuery = z.infer<typeof telegramCallbackQuerySchema>;

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  /** A malformed message is dropped instead of failing the whole batch. */
  message: telegramMessageSchema.optional().catch(undefined),
  callback_query: telegramCallbackQuerySchema.optional().catch(undefined),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

/** Rows of buttons under a message. */
export type InlineKeyboard = readonly (readonly InlineKeyboardButton[])[];

/** A button whose data is checked against `CALLBACK_DATA_PATTERN`; throws on invalid data. */
export function callbackButton(text: string, data: string): InlineKeyboardButton {
  if (!CALLBACK_DATA_PATTERN.test(data)) {
    throw new Error(`Invalid callback data format: ${JSON.stringify(data)}`);
  }
  return { text, callback_data: data };
}

export interface BotCommand {
  /** 1–32 chars: lowercase letters, digits, underscores. */
  readonly command: string;
  readonly description: string;
}

export type BotCommandScope =
  | { readonly type: 'default' }
  | { readonly type: 'all_private_chats' }
  | { readonly type: 'chat'; readonly chat_id: number };

export const apiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
  parameters: z.object({ retry_after: z.number().int().optional() }).optional(),
});
