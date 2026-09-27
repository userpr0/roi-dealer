import type { CommandCenter } from '@roi-dealer/command-center';
import type { Logger } from '@roi-dealer/observability';
import type { InlineKeyboard } from '@roi-dealer/telegram';

export interface PanelMessage {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

/**
 * Drives the command center like the Telegram router does: commands and button presses of the
 * owner, with fresh update ids (tg-update-<id>) for every call.
 */
export function createPanelDriver(center: CommandCenter, logger: Logger, ownerTelegramId: number) {
  let nextUpdate = 5_000;

  async function command(name: string, args = ''): Promise<PanelMessage[]> {
    const definition = center.commands.find((candidate) => candidate.name === name);
    if (definition === undefined) throw new Error(`no command ${name}`);
    const replies: PanelMessage[] = [];
    await definition.handler({
      chatId: ownerTelegramId,
      userId: ownerTelegramId,
      updateId: (nextUpdate += 1),
      args,
      logger,
      reply: (text, keyboard) => {
        replies.push({ text, keyboard });
        return Promise.resolve();
      },
    });
    return replies;
  }

  /** Presses a button; passing the same `queryId` repeats the delivery of one press. */
  async function press(data: string, queryId?: string) {
    const updateId = (nextUpdate += 1);
    const separator = data.indexOf(':');
    const callback = center.callbacks.find(
      (candidate) => candidate.prefix === data.slice(0, separator),
    );
    if (callback === undefined) throw new Error(`no callback for ${data}`);
    const edits: PanelMessage[] = [];
    const answers: string[] = [];
    await callback.handler({
      chatId: ownerTelegramId,
      messageId: 5,
      userId: ownerTelegramId,
      updateId,
      callbackQueryId: queryId ?? `q${updateId}`,
      data: data.slice(separator + 1),
      logger,
      edit: (text, keyboard) => {
        edits.push({ text, keyboard });
        return Promise.resolve();
      },
      reply: () => Promise.resolve(),
      answer: (text) => {
        answers.push(text);
        return Promise.resolve();
      },
    });
    return {
      edits,
      edit: edits.at(-1) ?? { text: '' },
      answers,
      correlationId: `tg-update-${updateId}`,
    };
  }

  return { command, press };
}

export function buttons(message: PanelMessage | undefined): string[] {
  return (message?.keyboard ?? []).flat().map((button) => button.callback_data);
}
