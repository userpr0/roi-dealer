import type { Logger } from '@roi-dealer/observability';
import {
  CALLBACK_DATA_PATTERN,
  type BotCommand,
  type InlineKeyboard,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from './api-types.js';
import type { TelegramClient } from './client.js';

export interface ParsedCommand {
  /** Lower-case command name without the leading slash. */
  readonly name: string;
  readonly args: string;
}

const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/;

/**
 * Parses `/command@bot args`. Returns `undefined` for plain text and for commands
 * addressed to a different bot.
 */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const match = COMMAND_PATTERN.exec(text.trim());
  const name = match?.[1];
  if (match === null || name === undefined) return undefined;

  const mention = match[2];
  if (
    mention !== undefined &&
    botUsername !== undefined &&
    mention.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return undefined;
  }
  return { name: name.toLowerCase(), args: (match[3] ?? '').trim() };
}

export interface CommandContext {
  readonly chatId: number;
  readonly userId: number;
  /** Telegram `update_id`: the correlation id of everything the command does is `tg-update-<id>`. */
  readonly updateId: number;
  readonly args: string;
  readonly logger: Logger;
  reply(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

/** A pressed inline button of the owner. */
export interface CallbackContext {
  readonly chatId: number;
  /** Message the button belongs to. */
  readonly messageId: number;
  readonly userId: number;
  readonly updateId: number;
  /** Telegram id of this press; a redelivered update carries the same id. */
  readonly callbackQueryId: string;
  /** The part of `callback_data` after `<prefix>:`. */
  readonly data: string;
  readonly logger: Logger;
  /** Replaces the text of the message with the button; buttons are replaced or removed. */
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  reply(text: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Short notice on the owner's screen. Without a call the router answers silently. */
  answer(text: string): Promise<void>;
}

/** Buttons with `callback_data` `<prefix>:<data>` go to this handler. */
export interface CallbackHandlerDefinition {
  /** 1–8 lowercase letters. */
  readonly prefix: string;
  readonly handler: (context: CallbackContext) => Promise<void>;
}

/**
 * A typed command. Rule: commands that change system state must ask the owner
 * for explicit confirmation before calling the backend (Input Router, playbook §3 #16).
 */
export interface BotCommandDefinition {
  readonly name: string;
  /** Shown in the Telegram command menu. */
  readonly description: string;
  readonly handler: (context: CommandContext) => Promise<void>;
}

export interface OwnerCommandRouterOptions {
  readonly ownerUserId: number;
  readonly commands: readonly BotCommandDefinition[];
  /** Inline button handlers; the poller must receive `callback_query` updates. */
  readonly callbacks?: readonly CallbackHandlerDefinition[];
  readonly client: Pick<TelegramClient, 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>;
  readonly logger: Logger;
  readonly botUsername?: string;
  /** Reply for plain text and unknown commands. */
  readonly unknownCommandReply: string;
  /** Reply when a handler throws. Details go to logs only. */
  readonly failureReply: string;
  /** Notice for a button nobody handles any more (old message, removed feature). */
  readonly unknownCallbackReply?: string;
}

const CALLBACK_PREFIX = /^[a-z]{1,8}$/;

export function toBotCommands(commands: readonly BotCommandDefinition[]): BotCommand[] {
  return commands.map(({ name, description }) => ({ command: name, description }));
}

/** Only the owner, only in the private chat with the bot. Logs why anything else is dropped. */
function fromOwner(
  message: Pick<TelegramMessage, 'chat'> | undefined,
  userId: number | undefined,
  ownerUserId: number,
  logger: Logger,
  kind: string,
): boolean {
  if (message !== undefined && message.chat.type !== 'private') {
    logger.warn(`telegram ${kind} ignored: not a private chat`, {
      chat_type: message.chat.type,
      chat_id: message.chat.id,
    });
    return false;
  }
  if (userId !== ownerUserId) {
    logger.warn(`telegram ${kind} rejected: sender is not the owner`, { user_id: userId });
    return false;
  }
  return true;
}

/**
 * Routes updates to command and button handlers. Only private-chat messages and button presses
 * of the owner are processed; everything else is dropped without a reply.
 * Message text is never logged; button data has a fixed safe format and is logged by prefix.
 */
export function createOwnerCommandRouter(
  options: OwnerCommandRouterOptions,
): (update: TelegramUpdate) => Promise<void> {
  const { ownerUserId, client, botUsername } = options;
  const handlers = new Map(options.commands.map((command) => [command.name, command]));
  const callbackHandlers = new Map<string, CallbackHandlerDefinition>();
  for (const callback of options.callbacks ?? []) {
    if (!CALLBACK_PREFIX.test(callback.prefix) || callbackHandlers.has(callback.prefix)) {
      throw new Error(`Invalid or duplicate callback prefix: ${callback.prefix}`);
    }
    callbackHandlers.set(callback.prefix, callback);
  }

  async function handleMessage(
    updateId: number,
    message: TelegramMessage & { text: string },
    logger: Logger,
  ): Promise<void> {
    if (!fromOwner(message, message.from?.id, ownerUserId, logger, 'message')) return;

    const chatId = message.chat.id;
    const reply = (text: string, keyboard?: InlineKeyboard): Promise<void> =>
      client.sendMessage({ chatId, text, keyboard });
    const parsed = parseCommand(message.text, botUsername);
    const command = parsed === undefined ? undefined : handlers.get(parsed.name);
    if (parsed === undefined || command === undefined) {
      logger.info('telegram message without a known command', { command: parsed?.name });
      await reply(options.unknownCommandReply);
      return;
    }

    const startedAt = performance.now();
    try {
      await command.handler({
        chatId,
        userId: ownerUserId,
        updateId,
        args: parsed.args,
        logger,
        reply,
      });
      logger.info('telegram command handled', {
        command: command.name,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      logger.error('telegram command failed', { command: command.name, error });
      await reply(options.failureReply);
    }
  }

  async function handleCallback(
    updateId: number,
    query: TelegramCallbackQuery,
    logger: Logger,
  ): Promise<void> {
    if (!fromOwner(query.message, query.from.id, ownerUserId, logger, 'button press')) return;

    let answered = false;
    const answer = async (text?: string): Promise<void> => {
      if (answered) return;
      answered = true;
      try {
        await client.answerCallbackQuery({ callbackQueryId: query.id, text });
      } catch (error) {
        // Presses older than ~15 minutes (e.g. a redelivered update) cannot be answered.
        logger.warn('telegram button press not answered', { error });
      }
    };

    const valid = query.data !== undefined && CALLBACK_DATA_PATTERN.test(query.data);
    const separator = valid ? (query.data?.indexOf(':') ?? -1) : -1;
    const prefix = query.data?.slice(0, separator);
    const callback = prefix === undefined ? undefined : callbackHandlers.get(prefix);
    const message = query.message;
    if (!valid || callback === undefined || message === undefined) {
      logger.info('telegram button press without a handler', {
        prefix: valid ? prefix : undefined,
        message_available: message !== undefined,
      });
      await answer(options.unknownCallbackReply ?? options.unknownCommandReply);
      return;
    }

    const chatId = message.chat.id;
    const startedAt = performance.now();
    try {
      await callback.handler({
        chatId,
        messageId: message.message_id,
        userId: ownerUserId,
        updateId,
        callbackQueryId: query.id,
        data: query.data?.slice(separator + 1) ?? '',
        logger,
        edit: (text, keyboard) =>
          client.editMessageText({ chatId, messageId: message.message_id, text, keyboard }),
        reply: (text, keyboard) => client.sendMessage({ chatId, text, keyboard }),
        answer,
      });
      logger.info('telegram button press handled', {
        prefix: callback.prefix,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      await answer();
    } catch (error) {
      logger.error('telegram button press failed', { prefix: callback.prefix, error });
      await answer(options.failureReply);
    }
  }

  return async (update) => {
    const logger = options.logger.child({ correlation_id: `tg-update-${update.update_id}` });
    const { message, callback_query: query } = update;
    if (query !== undefined) {
      await handleCallback(update.update_id, query, logger);
      return;
    }
    if (message?.text === undefined) {
      logger.debug('telegram update ignored: no text message or button press');
      return;
    }
    await handleMessage(update.update_id, { ...message, text: message.text }, logger);
  };
}
