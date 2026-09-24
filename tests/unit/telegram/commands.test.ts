import { describe, expect, it, vi } from 'vitest';
import {
  createOwnerCommandRouter,
  createOwnerNotifier,
  parseCommand,
  toBotCommands,
  type BotCommandDefinition,
  type TelegramUpdate,
} from '@roi-dealer/telegram';
import { createCapturingLogger } from '../../support/logger.js';

const OWNER = 1001;

function update(text: string | undefined, fromId = OWNER, chatType = 'private'): TelegramUpdate {
  return {
    update_id: 55,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatType === 'private' ? fromId : -1, type: chatType },
      from: { id: fromId, is_bot: false, first_name: 'User' },
      ...(text === undefined ? {} : { text }),
    },
  };
}

function setup(commands?: BotCommandDefinition[]) {
  const { logger, records } = createCapturingLogger('bot');
  const sendMessage = vi.fn<(params: { chatId: number; text: string }) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const status = vi.fn(async (context: { reply(text: string): Promise<void> }) => {
    await context.reply('status ok');
  });
  const router = createOwnerCommandRouter({
    ownerUserId: OWNER,
    commands: commands ?? [{ name: 'status', description: 'Status', handler: status }],
    client: { sendMessage },
    logger,
    botUsername: 'roi_bot',
    unknownCommandReply: 'unknown',
    failureReply: 'failed',
  });
  return { router, sendMessage, status, records };
}

describe('parseCommand', () => {
  it.each([
    ['/status', { name: 'status', args: '' }],
    ['/Status extra  args ', { name: 'status', args: 'extra  args' }],
    ['/status@roi_bot', { name: 'status', args: '' }],
    ['/status@ROI_BOT now', { name: 'status', args: 'now' }],
  ])('parses %j', (text, expected) => {
    expect(parseCommand(text, 'roi_bot')).toEqual(expected);
  });

  it.each(['status', 'hello /status', '/', '/status@other_bot', ''])('ignores %j', (text) => {
    expect(parseCommand(text, 'roi_bot')).toBeUndefined();
  });
});

describe('createOwnerCommandRouter', () => {
  it('runs the command for the owner and replies in the same chat', async () => {
    const { router, sendMessage, status } = setup();

    await router(update('/status'));

    expect(status).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({ chatId: OWNER, text: 'status ok' });
  });

  it('drops messages from other users without replying and logs only their id', async () => {
    const { router, sendMessage, status, records } = setup();

    await router(update('/status secret words', 666));

    expect(status).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'telegram message rejected: sender is not the owner',
        user_id: 666,
        correlation_id: 'tg-update-55',
      }),
    );
    expect(JSON.stringify(records)).not.toContain('secret words');
  });

  it('ignores the owner in group chats', async () => {
    const { router, sendMessage } = setup();
    await router(update('/status', OWNER, 'group'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores updates without text', async () => {
    const { router, sendMessage } = setup();
    await router(update(undefined));
    await router({ update_id: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('answers plain text and unknown commands with a hint', async () => {
    const { router, sendMessage } = setup();

    await router(update('hello'));
    await router(update('/deploy'));

    expect(sendMessage.mock.calls.map(([params]) => params.text)).toEqual(['unknown', 'unknown']);
  });

  it('replies with a generic failure and logs the error when a handler throws', async () => {
    const { router, sendMessage, records } = setup([
      {
        name: 'status',
        description: 'Status',
        handler: () => Promise.reject(new Error('database unavailable')),
      },
    ]);

    await router(update('/status'));

    expect(sendMessage).toHaveBeenCalledWith({ chatId: OWNER, text: 'failed' });
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'telegram command failed',
        command: 'status',
      }),
    );
  });

  it('exposes commands for the Telegram menu', () => {
    expect(
      toBotCommands([{ name: 'status', description: 'Status', handler: () => Promise.resolve() }]),
    ).toEqual([{ command: 'status', description: 'Status' }]);
  });
});

describe('createOwnerNotifier', () => {
  it('sends to the owner chat', async () => {
    const { logger } = createCapturingLogger('bot');
    const sendMessage = vi.fn(() => Promise.resolve());
    const notifier = createOwnerNotifier({ client: { sendMessage }, ownerChatId: OWNER, logger });

    await expect(notifier.notify('hello')).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ chatId: OWNER, text: 'hello' });
  });

  it('never throws and logs a failure', async () => {
    const { logger, records } = createCapturingLogger('bot');
    const notifier = createOwnerNotifier({
      client: { sendMessage: () => Promise.reject(new Error('network down')) },
      ownerChatId: OWNER,
      logger,
    });

    await expect(notifier.notify('hello')).resolves.toBe(false);
    expect(records).toContainEqual(
      expect.objectContaining({ message: 'owner notification failed' }),
    );
  });
});
