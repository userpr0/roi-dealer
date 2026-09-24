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

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  /** A malformed message is dropped instead of failing the whole batch. */
  message: telegramMessageSchema.optional().catch(undefined),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

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
