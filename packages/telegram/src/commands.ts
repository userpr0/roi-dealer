import type { Logger } from '@roi-dealer/observability';
import type { BotCommand, TelegramUpdate } from './api-types.js';
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
  readonly args: string;
  readonly logger: Logger;
  reply(text: string): Promise<void>;
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
  readonly client: Pick<TelegramClient, 'sendMessage'>;
  readonly logger: Logger;
  readonly botUsername?: string;
  /** Reply for plain text and unknown commands. */
  readonly unknownCommandReply: string;
  /** Reply when a handler throws. Details go to logs only. */
  readonly failureReply: string;
}

export function toBotCommands(commands: readonly BotCommandDefinition[]): BotCommand[] {
  return commands.map(({ name, description }) => ({ command: name, description }));
}

/**
 * Routes updates to command handlers. Only private-chat messages from the owner are processed;
 * everything else is dropped without a reply. Message text is never logged.
 */
export function createOwnerCommandRouter(
  options: OwnerCommandRouterOptions,
): (update: TelegramUpdate) => Promise<void> {
  const { ownerUserId, client, botUsername } = options;
  const handlers = new Map(options.commands.map((command) => [command.name, command]));

  return async (update) => {
    const logger = options.logger.child({ correlation_id: `tg-update-${update.update_id}` });
    const message = update.message;
    if (message?.text === undefined) {
      logger.debug('telegram update ignored: no text message');
      return;
    }
    if (message.chat.type !== 'private') {
      logger.warn('telegram message ignored: not a private chat', {
        chat_type: message.chat.type,
        chat_id: message.chat.id,
      });
      return;
    }
    if (message.from?.id !== ownerUserId) {
      logger.warn('telegram message rejected: sender is not the owner', {
        user_id: message.from?.id,
      });
      return;
    }

    const chatId = message.chat.id;
    const reply = (text: string): Promise<void> => client.sendMessage({ chatId, text });
    const parsed = parseCommand(message.text, botUsername);
    const command = parsed === undefined ? undefined : handlers.get(parsed.name);
    if (parsed === undefined || command === undefined) {
      logger.info('telegram message without a known command', { command: parsed?.name });
      await reply(options.unknownCommandReply);
      return;
    }

    const startedAt = performance.now();
    try {
      await command.handler({ chatId, userId: ownerUserId, args: parsed.args, logger, reply });
      logger.info('telegram command handled', {
        command: command.name,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      logger.error('telegram command failed', { command: command.name, error });
      await reply(options.failureReply);
    }
  };
}
