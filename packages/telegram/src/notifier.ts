import type { Logger } from '@roi-dealer/observability';
import type { TelegramClient } from './client.js';

export interface OwnerNotifier {
  /** Sends a plain-text message to the owner. Never throws; resolves `false` on failure. */
  notify(text: string): Promise<boolean>;
}

export interface OwnerNotifierOptions {
  readonly client: Pick<TelegramClient, 'sendMessage'>;
  /** In a private chat the chat id equals the owner's user id. */
  readonly ownerChatId: number;
  readonly logger: Logger;
}

export function createOwnerNotifier(options: OwnerNotifierOptions): OwnerNotifier {
  const { client, ownerChatId, logger } = options;
  return {
    async notify(text) {
      try {
        await client.sendMessage({ chatId: ownerChatId, text });
        return true;
      } catch (error) {
        logger.warn('owner notification failed', { error });
        return false;
      }
    },
  };
}
