export {
  CALLBACK_DATA_PATTERN,
  callbackButton,
  telegramCallbackQuerySchema,
  telegramChatSchema,
  telegramMessageSchema,
  telegramUpdateSchema,
  telegramUserSchema,
  type BotCommand,
  type BotCommandScope,
  type InlineKeyboard,
  type InlineKeyboardButton,
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './api-types.js';
export {
  DEFAULT_TELEGRAM_API_BASE_URL,
  telegramApiBaseUrlSchema,
  telegramBotTokenSchema,
  telegramUserIdSchema,
} from './config.js';
export {
  createTelegramClient,
  redactSecret,
  TelegramApiError,
  TelegramRequestError,
  type GetUpdatesParams,
  type TelegramClient,
  type TelegramClientOptions,
} from './client.js';
export { createLongPoller, type LongPoller, type LongPollerOptions } from './polling.js';
export {
  createOwnerCommandRouter,
  parseCommand,
  toBotCommands,
  type BotCommandDefinition,
  type CallbackContext,
  type CallbackHandlerDefinition,
  type CommandContext,
  type OwnerCommandRouterOptions,
  type ParsedCommand,
} from './commands.js';
export { createOwnerNotifier, type OwnerNotifier, type OwnerNotifierOptions } from './notifier.js';

export const PACKAGE_NAME = '@roi-dealer/telegram';
