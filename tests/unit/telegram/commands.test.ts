import { describe, expect, it, vi } from 'vitest';
import {
  callbackButton,
  createOwnerCommandRouter,
  createOwnerNotifier,
  parseCommand,
  toBotCommands,
  type BotCommandDefinition,
  type CallbackContext,
  type CallbackHandlerDefinition,
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

function press(
  data: string | undefined,
  { fromId = OWNER, chatType = 'private', withMessage = true } = {},
): TelegramUpdate {
  return {
    update_id: 56,
    callback_query: {
      id: '4382bfdwdsb323b2d9',
      from: { id: fromId, is_bot: false, first_name: 'User' },
      ...(withMessage
        ? {
            message: {
              message_id: 7,
              date: 0,
              chat: { id: chatType === 'private' ? fromId : -1, type: chatType },
            },
          }
        : {}),
      ...(data === undefined ? {} : { data }),
    },
  };
}

function setup(commands?: BotCommandDefinition[], callbacks?: CallbackHandlerDefinition[]) {
  const { logger, records } = createCapturingLogger('bot');
  const sendMessage = vi.fn<(params: { chatId: number; text: string }) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const editMessageText = vi.fn<
    (params: { chatId: number; messageId: number; text: string }) => Promise<void>
  >(() => Promise.resolve());
  const answerCallbackQuery = vi.fn<
    (params: { callbackQueryId: string; text?: string | undefined }) => Promise<void>
  >(() => Promise.resolve());
  const status = vi.fn(async (context: { reply(text: string): Promise<void> }) => {
    await context.reply('status ok');
  });
  const confirm = vi.fn(async (context: CallbackContext) => {
    await context.edit(`confirmed ${context.data}`);
  });
  const router = createOwnerCommandRouter({
    ownerUserId: OWNER,
    commands: commands ?? [{ name: 'status', description: 'Status', handler: status }],
    callbacks: callbacks ?? [{ prefix: 'ap', handler: confirm }],
    client: { sendMessage, editMessageText, answerCallbackQuery },
    logger,
    botUsername: 'roi_bot',
    unknownCommandReply: 'unknown',
    failureReply: 'failed',
    unknownCallbackReply: 'outdated',
  });
  return { router, sendMessage, editMessageText, answerCallbackQuery, status, confirm, records };
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

  it('passes the update id to the command for correlation', async () => {
    const handler = vi.fn((context: { updateId: number }) => {
      expect(context.updateId).toBe(55);
      return Promise.resolve();
    });
    const { router } = setup([{ name: 'status', description: 'Status', handler }]);
    await router(update('/status'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('exposes commands for the Telegram menu', () => {
    expect(
      toBotCommands([{ name: 'status', description: 'Status', handler: () => Promise.resolve() }]),
    ).toEqual([{ command: 'status', description: 'Status' }]);
  });
});

describe('createOwnerCommandRouter with inline buttons', () => {
  it('routes the owner press by prefix, edits the message and answers once', async () => {
    const { router, confirm, editMessageText, answerCallbackQuery, records } = setup();

    await router(press('ap:ya:0190c5a6'));

    expect(confirm).toHaveBeenCalledOnce();
    const [context] = confirm.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      chatId: OWNER,
      messageId: 7,
      userId: OWNER,
      updateId: 56,
      callbackQueryId: '4382bfdwdsb323b2d9',
      data: 'ya:0190c5a6',
    });
    expect(editMessageText).toHaveBeenCalledWith({
      chatId: OWNER,
      messageId: 7,
      text: 'confirmed ya:0190c5a6',
    });
    expect(answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({
      callbackQueryId: '4382bfdwdsb323b2d9',
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'telegram button press handled',
        prefix: 'ap',
        correlation_id: 'tg-update-56',
      }),
    );
  });

  it('keeps the notice given by the handler', async () => {
    const { router, answerCallbackQuery } = setup(undefined, [
      { prefix: 'ap', handler: (context) => context.answer('Already decided') },
    ]);
    await router(press('ap:x'));
    expect(answerCallbackQuery).toHaveBeenCalledExactlyOnceWith({
      callbackQueryId: '4382bfdwdsb323b2d9',
      text: 'Already decided',
    });
  });

  it('drops presses of other users and in group chats without answering', async () => {
    const { router, confirm, answerCallbackQuery, records } = setup();

    await router(press('ap:x', { fromId: 666 }));
    await router(press('ap:x', { chatType: 'group' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(answerCallbackQuery).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'telegram button press rejected: sender is not the owner',
        user_id: 666,
      }),
    );
  });

  it.each([
    ['unknown prefix', press('zz:x')],
    ['malformed data', press('ap:<script>')],
    ['no data', press(undefined)],
    ['message too old to show', press('ap:x', { withMessage: false })],
  ])('answers %s as outdated without running a handler', async (_case, pressed) => {
    const { router, confirm, answerCallbackQuery, records } = setup();

    await router(pressed);

    expect(confirm).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: '4382bfdwdsb323b2d9',
      text: 'outdated',
    });
    expect(JSON.stringify(records)).not.toContain('<script>');
  });

  it('answers with a generic failure when the handler throws', async () => {
    const { router, answerCallbackQuery, records } = setup(undefined, [
      { prefix: 'ap', handler: () => Promise.reject(new Error('database unavailable')) },
    ]);

    await router(press('ap:x'));

    expect(answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: '4382bfdwdsb323b2d9',
      text: 'failed',
    });
    expect(records).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'telegram button press failed' }),
    );
  });

  it('survives a press that can no longer be answered', async () => {
    const { router, answerCallbackQuery, records } = setup();
    answerCallbackQuery.mockRejectedValueOnce(new Error('query is too old'));

    await expect(router(press('ap:x'))).resolves.toBeUndefined();
    expect(records).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'telegram button press not answered' }),
    );
  });

  it('refuses invalid or duplicate prefixes', () => {
    const handler = () => Promise.resolve();
    expect(() => setup(undefined, [{ prefix: 'Bad', handler }])).toThrow(/prefix/);
    expect(() =>
      setup(undefined, [
        { prefix: 'ap', handler },
        { prefix: 'ap', handler },
      ]),
    ).toThrow(/prefix/);
  });
});

describe('callbackButton', () => {
  it('builds a button with checked data', () => {
    expect(callbackButton('✅', 'ap:a:0190c5a6-7b8e-7c3d-9f00-123456789abc')).toEqual({
      text: '✅',
      callback_data: 'ap:a:0190c5a6-7b8e-7c3d-9f00-123456789abc',
    });
  });

  it.each(['ap', 'AP:x', 'ap:with space', `ap:${'x'.repeat(56)}`, 'toolongprefix:x'])(
    'refuses %j',
    (data) => {
      expect(() => callbackButton('x', data)).toThrow(/callback data/);
    },
  );
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
