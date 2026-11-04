import { randomBytes } from 'node:crypto';
import {
  timestampMs,
  watchGrowth,
  type Actor,
  type Pain,
  type PainId,
  type Timestamp,
  type WatchGrowth,
} from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import { closestPains } from '@roi-dealer/signals';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboardButton,
} from '@roi-dealer/telegram';
import { formatKyivDate } from './kyiv-time.js';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';
import { shorten } from './texts.js';

/*
 * /watchlist (phase 27, ADR-0013): pains the owner cut off — rejected pains and the pains of
 * rejected or killed opportunities — stay watched. When new open pains similar to one gather
 * twice its signals from a source it never had, the owner decides: look again or keep it cut.
 */

export const WATCHLIST_PREFIX = 'wl';

type WatchStore = Pick<Database, 'repositories' | 'watchlist'>;
const SHOWN = 5;
const MAX_PENDING = 20;

export interface WatchItem {
  readonly pain: Pain;
  /** When it was cut off. */
  readonly cutAt: Timestamp;
  readonly reason: 'pain_rejected' | 'opportunity_closed';
  readonly echoes: readonly Pain[];
  readonly growth: WatchGrowth;
}

async function sourcesOf(
  database: WatchStore,
  pains: readonly Pain[],
): Promise<Map<PainId, string[]>> {
  const ids = [...new Set(pains.flatMap((pain) => pain.evidenceIds))];
  const evidence = ids.length === 0 ? [] : await database.repositories.evidence.getByIds(ids);
  const sourceOf = new Map(evidence.map((item) => [item.id, item.sourceId as string]));
  return new Map(
    pains.map((pain) => [
      pain.id,
      [...new Set(pain.evidenceIds.flatMap((id) => sourceOf.get(id) ?? []))],
    ]),
  );
}

/** Every watched pain with its similar new pains and the growth code computes. */
export async function watchItems(database: WatchStore): Promise<WatchItem[]> {
  const { repositories } = database;
  const [rejected, closedRejected, closedKilled, candidates, validated, decisions] =
    await Promise.all([
      repositories.pains.listByStatus('rejected', { limit: 1_000 }),
      repositories.opportunities.listByStatus('rejected', { limit: 1_000 }),
      repositories.opportunities.listByStatus('killed', { limit: 1_000 }),
      repositories.pains.listByStatus('candidate', { limit: 1_000 }),
      repositories.pains.listByStatus('validated', { limit: 1_000 }),
      database.watchlist.decisions(),
    ]);
  const cut = new Map<PainId, { cutAt: Timestamp; reason: WatchItem['reason'] }>();
  for (const pain of rejected) cut.set(pain.id, { cutAt: pain.updatedAt, reason: 'pain_rejected' });
  const closedPainIds = [...closedRejected, ...closedKilled].flatMap((item) =>
    item.painIds.map((id) => ({ id, cutAt: item.updatedAt })),
  );
  const closedPains = await repositories.pains.getByIds([
    ...new Set(closedPainIds.map((item) => item.id)),
  ]);
  for (const { id, cutAt } of closedPainIds) {
    if (!cut.has(id)) cut.set(id, { cutAt, reason: 'opportunity_closed' });
  }
  const watched = [
    ...rejected,
    ...closedPains.filter((pain) => !rejected.some((r) => r.id === pain.id)),
  ];
  const open = [...candidates, ...validated];
  const sources = await sourcesOf(database, [...watched, ...open]);
  return watched.flatMap((pain) => {
    const mark = cut.get(pain.id);
    if (mark === undefined) return [];
    const later = open.filter(
      (other) => other.id !== pain.id && timestampMs(other.createdAt) > timestampMs(mark.cutAt),
    );
    const echoes = closestPains(pain.title, pain.audience, later);
    const decision = decisions.get(pain.id);
    const growth = watchGrowth(
      { signals: pain.signalIds.length, sources: sources.get(pain.id) ?? [] },
      echoes.map((echo) => ({
        signals: echo.signalIds.length,
        sources: sources.get(echo.id) ?? [],
      })),
      decision?.decision === 'kept' ? decision.signals : 0,
    );
    // A returned pain is in review again: no more questions about it.
    if (decision?.decision === 'returned') return [];
    return [{ pain, cutAt: mark.cutAt, reason: mark.reason, echoes, growth }];
  });
}

const REASON_TEXT: Readonly<Record<WatchItem['reason'], string>> = {
  pain_rejected: 'боль отклонена',
  opportunity_closed: 'возможность закрыта',
};

export interface WatchlistView {
  readonly text: string;
  readonly keyboard?: readonly (readonly InlineKeyboardButton[])[] | undefined;
}

export async function watchlistView(database: WatchStore): Promise<WatchlistView> {
  const items = await watchItems(database);
  const growing = items.filter((item) => item.growth.growing);
  const [falseRejections] = await Promise.all([database.watchlist.falseRejections()]);
  const lines = [
    `👀 Лист наблюдения: под наблюдением ${String(items.length)}, снова растут ${String(growing.length)}`,
  ];
  const keyboard: (readonly InlineKeyboardButton[])[] = [];
  for (const item of growing.slice(0, SHOWN)) {
    const [echo] = item.echoes;
    lines.push(
      '',
      `«${shorten(item.pain.title, 100)}» — ${REASON_TEXT[item.reason]} ${formatKyivDate(timestampMs(item.cutAt))}`,
      `Тогда: сигналов ${String(item.pain.signalIds.length)} · теперь в похожих болях: ${String(item.growth.signals)}, новых источников ${String(item.growth.newSources.length)}`,
      ...(echo === undefined ? [] : [`Похожая новая боль: «${shorten(echo.title, 100)}»`]),
      'Вернуть на рассмотрение?',
    );
    if (echo !== undefined) {
      keyboard.push([
        callbackButton('↩️ Вернуть', `${WATCHLIST_PREFIX}:r:${item.pain.id}`),
        callbackButton('Оставить', `${WATCHLIST_PREFIX}:k:${item.pain.id}`),
      ]);
    }
  }
  if (growing.length === 0) lines.push('', 'Отсечённое не растёт — смотреть нечего.');
  lines.push(
    '',
    `Ложных отказов (вернули, и потом подтвердилось): ${String(falseRejections)}`,
    'Код считает похожие боли и источники; решаете вы.',
  );
  return { text: lines.join('\n'), ...(keyboard.length === 0 ? {} : { keyboard }) };
}

/** One digest line when something cut off grows again. */
export async function watchlistDigestLine(database: WatchStore): Promise<string | undefined> {
  const growing = (await watchItems(database)).filter((item) => item.growth.growing).length;
  return growing === 0 ? undefined : `👀 Отсечённое снова растёт: ${String(growing)} → /watchlist`;
}

export interface WatchlistFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (userId: number) => Actor;
}

export interface WatchlistFlow {
  readonly watchlist: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

export function createWatchlistFlow(deps: WatchlistFlowDeps): WatchlistFlow {
  const pending = new Map<
    string,
    {
      painId: PainId;
      echoPainId: PainId;
      decision: 'returned' | 'kept';
      signals: number;
      expiresAtMs: number;
    }
  >();
  const nowMs = (): number => timestampMs(deps.now());

  return {
    async watchlist(context) {
      const view = await watchlistView(deps.database);
      await context.reply(view.text, view.keyboard);
    },

    async handleButton(context) {
      const [, action, first] = context.data.split(':');
      if ((action === 'r' || action === 'k') && first !== undefined) {
        // The similar pain and the growth are computed again: the card may be old.
        const item = (await watchItems(deps.database)).find(
          (entry) => entry.pain.id === first && entry.growth.growing,
        );
        const pain = item?.pain;
        const echo = item?.echoes[0];
        if (item === undefined || pain === undefined || echo === undefined) {
          await context.edit('Карточка устарела. Повторите /watchlist.');
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
        const decision = action === 'r' ? 'returned' : 'kept';
        pending.set(nonce, {
          painId: pain.id,
          echoPainId: echo.id,
          decision,
          signals: item.growth.signals,
          expiresAtMs: current + CONFIRMATION_TTL_MS,
        });
        await context.edit(
          decision === 'returned'
            ? `↩️ Вернуть на рассмотрение «${shorten(pain.title, 100)}»? Похожая новая боль «${shorten(echo.title, 100)}» пойдёт в /pains как продолжение. Подтверждение действует 10 минут.`
            : `Оставить «${shorten(pain.title, 100)}» отсечённой? Спрошу снова, только если похожих сигналов станет вдвое больше. Подтверждение действует 10 минут.`,
          [
            [
              callbackButton(
                decision === 'returned' ? '↩️ Да, вернуть' : 'Да, оставить',
                `${WATCHLIST_PREFIX}:y:${nonce}`,
              ),
              callbackButton('Отмена', `${WATCHLIST_PREFIX}:n:${nonce}`),
            ],
          ],
        );
        return;
      }
      const confirmation = first === undefined ? undefined : pending.get(first);
      if (action === 'n' && first !== undefined) {
        pending.delete(first);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (action !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /watchlist.');
        return;
      }
      const actor = deps.owner(context.userId);
      await deps.database.command(
        {
          name: 'watchlist.decide',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async (scope) => {
          await scope.watchlist.decide({
            painId: confirmation.painId,
            echoPainId: confirmation.echoPainId,
            decision: confirmation.decision,
            signals: confirmation.signals,
            actorId: actor.id,
            correlationId: `tg-update-${String(context.updateId)}`,
          });
          return { painId: confirmation.painId };
        },
      );
      pending.delete(first ?? '');
      await context.edit(
        confirmation.decision === 'returned'
          ? '↩️ Возвращено: похожая боль — в /pains. Если она потом подтвердится, это будет ложный отказ в точности.'
          : 'Оставлено отсечённым.',
      );
    },
  };
}
