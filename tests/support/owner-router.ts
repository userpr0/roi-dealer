import {
  createOwnerCommandRouter,
  type BotCommandDefinition,
  type CallbackHandlerDefinition,
  type InlineKeyboard,
  type PhotoHandlerDefinition,
  type TelegramPhotoSize,
} from '@roi-dealer/telegram';
import type { Logger } from '@roi-dealer/observability';

/** A message the bot sent or a message it edited after a button press. */
export interface RoutedMessage {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
  readonly edited: boolean;
}

export const ROUTER_OWNER_ID = 4_242;

/**
 * Update and button-press ids are unique across every harness of a test file, as in Telegram:
 * the command center keys its commands by them (`tg-callback-<id>`), so a repeated id would be
 * a repeated press.
 */
let updateId = 10_000;
let pressId = 0;

/**
 * The owner's chat through the real router of the bot (`createOwnerCommandRouter`): commands
 * and button presses reach the handlers exactly as from Telegram — the handler gets the button
 * data after its `<prefix>:`. Tests that call handlers directly cannot see how the router splits
 * the data; this harness can.
 */
export function ownerRouter(options: {
  readonly logger: Logger;
  readonly commands?: readonly BotCommandDefinition[];
  readonly callbacks?: readonly CallbackHandlerDefinition[];
  /** The owner's photos (phase 36). */
  readonly photo?: PhotoHandlerDefinition | undefined;
}) {
  const messages: RoutedMessage[] = [];
  /** Files the owner's photos point to, by file id. */
  const files = new Map<string, Uint8Array>();
  const route = createOwnerCommandRouter({
    ownerUserId: ROUTER_OWNER_ID,
    commands: options.commands ?? [],
    callbacks: options.callbacks ?? [],
    client: {
      sendMessage: ({ text, keyboard }) => {
        messages.push({ text, keyboard, edited: false });
        return Promise.resolve();
      },
      editMessageText: ({ text, keyboard }) => {
        messages.push({ text, keyboard, edited: true });
        return Promise.resolve();
      },
      answerCallbackQuery: () => Promise.resolve(),
      getFile: ({ fileId }) =>
        Promise.resolve({ filePath: `photos/${fileId}.jpg`, fileSize: files.get(fileId)?.length }),
      downloadFile: ({ filePath }) => {
        const bytes = files.get(filePath.replace(/^photos\/|\.jpg$/g, ''));
        return bytes === undefined ? Promise.reject(new Error('no file')) : Promise.resolve(bytes);
      },
    },
    photo: options.photo,
    logger: options.logger,
    unknownCommandReply: 'unknown command',
    failureReply: 'handler failed',
  });
  const chat = { id: ROUTER_OWNER_ID, type: 'private' };
  const from = { id: ROUTER_OWNER_ID, is_bot: false, first_name: 'Owner' };

  return {
    messages,
    /** The owner sends a message, e.g. `/seek escrow for freelancers`. */
    send: (text: string) =>
      route({
        update_id: (updateId += 1),
        message: { message_id: updateId, date: 0, chat, from, text },
      }),
    /** The owner presses a button with this full `callback_data`, e.g. `sk:y:<nonce>`. */
    press: (data: string) =>
      route({
        update_id: (updateId += 1),
        callback_query: {
          id: `press-${String((pressId += 1))}`,
          from,
          message: { message_id: 1, date: 0, chat },
          data,
        },
      }),
    /** The owner sends a photo: its sizes (smallest first) and the bytes of each size. */
    sendPhoto: (sizes: readonly (TelegramPhotoSize & { readonly bytes: Uint8Array })[]) => {
      for (const size of sizes) files.set(size.file_id, size.bytes);
      return route({
        update_id: (updateId += 1),
        message: {
          message_id: updateId,
          date: 0,
          chat,
          from,
          photo: sizes.map(({ bytes: _bytes, ...size }) => size),
        },
      });
    },
    last: (): RoutedMessage | undefined => messages.at(-1),
    /** `callback_data` of the buttons of a message (default: the last one). */
    buttons: (message: RoutedMessage | undefined = messages.at(-1)): string[] =>
      (message?.keyboard ?? []).flat().map((button) => button.callback_data),
  };
}
