import { randomBytes } from 'node:crypto';
import { timestampMs, type Actor, type Timestamp } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import { callbackButton, type CallbackContext, type CommandContext } from '@roi-dealer/telegram';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';

/*
 * /seek: the owner gives a topic in plain English words; the research agent searches it on its
 * allowed source in its next run (kill switch, catalog, the source's grant, redaction — as for
 * every search). The evidence then goes the usual way: pains, assessment, the owner decides.
 */

export const SEEK_PREFIX = 'sk';
export const SEEK_USAGE =
  'Тема поиска: /seek escrow for freelancers — 2–5 английских слов (источники англоязычные).';
const MIN_WORDS = 2;
const MAX_WORDS = 5;
const MAX_CHARS = 60;
const SHOWN = 10;
const MAX_PENDING = 20;

/** The owner's words reduced to a search query, or undefined when they do not fit. */
export function seekQuery(text: string): string | undefined {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
  const query = words.join(' ');
  return words.length < MIN_WORDS || words.length > MAX_WORDS || query.length > MAX_CHARS
    ? undefined
    : query;
}

export async function seekListText(database: Pick<Database, 'seek'>): Promise<string> {
  const topics = await database.seek.list(SHOWN);
  if (topics.length === 0) return `🔎 Тем поиска нет.\n${SEEK_USAGE}`;
  return [
    '🔎 Темы поиска:',
    ...topics.map(
      (topic) =>
        `• «${topic.query}» — ${topic.evidence === undefined ? 'ждёт агента исследований' : `найдено ${String(topic.evidence)}`}`,
    ),
    'Найденное идёт обычным путём: боли → оценка → ваше решение.',
  ].join('\n');
}

export interface SeekFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (userId: number) => Actor;
}

export interface SeekFlow {
  readonly seek: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

export function createSeekFlow(deps: SeekFlowDeps): SeekFlow {
  const pending = new Map<string, { query: string; expiresAtMs: number }>();
  const nowMs = (): number => timestampMs(deps.now());

  return {
    async seek(context) {
      if (context.args.trim() === '') {
        await context.reply(await seekListText(deps.database));
        return;
      }
      const query = seekQuery(context.args);
      if (query === undefined) {
        await context.reply(`⛔ ${SEEK_USAGE}`);
        return;
      }
      const current = nowMs();
      for (const [nonce, item] of pending) if (item.expiresAtMs <= current) pending.delete(nonce);
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const nonce = randomBytes(8).toString('hex');
      pending.set(nonce, { query, expiresAtMs: current + CONFIRMATION_TTL_MS });
      await context.reply(
        `🔎 Искать «${query}»? Агент исследований поищет в следующий запуск в разрешённых источниках. Подтверждение действует 10 минут.`,
        [
          [
            callbackButton('🔎 Искать', `${SEEK_PREFIX}:y:${nonce}`),
            callbackButton('Отмена', `${SEEK_PREFIX}:n:${nonce}`),
          ],
        ],
      );
    },

    async handleButton(context) {
      const [, action, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (action === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (action !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /seek.');
        return;
      }
      const actor = deps.owner(context.userId);
      await deps.database.command(
        {
          name: 'seek.add',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async (scope) => {
          await scope.seek.add({
            query: confirmation.query,
            actorId: actor.id,
            correlationId: `tg-update-${String(context.updateId)}`,
          });
          return { query: confirmation.query };
        },
      );
      pending.delete(nonce ?? '');
      await context.edit(`🔎 Тема «${confirmation.query}» записана. Итог — /seek.`);
    },
  };
}
