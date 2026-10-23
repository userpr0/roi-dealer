import {
  changePainStatus,
  confirmPainByOwner,
  isFavoritePain,
  MIN_SOURCES_FOR_VALIDATED_PAIN,
  painIdSchema,
  painRating,
  type Actor,
  type Pain,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  ConcurrencyError,
  type Database,
  type PainReviewQueries,
  type PainTranslation,
  type Repositories,
} from '@roi-dealer/database';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';

/** At most this many pains are listed in /pains. */
export const PAINS_SHOWN = 10;
/**
 * Buttons under /pains: `pn:<action>:<pain id>:<version>` — confirm (PHASE 13 + D-030) and
 * reject (PHASE 13), each asked first.
 */
export const PAIN_PREFIX = 'pn';
const BUTTONS_IN_ROW = 5;

const FREQUENCY_LABELS: Readonly<Record<Pain['frequency'], string>> = {
  rare: 'редко',
  occasional: 'иногда',
  frequent: 'часто',
  constant: 'постоянно',
};

export const NO_PAINS_TEXT =
  '🧩 Болей пока не найдено.\n\nАгент болей и сигналов разбирает новые доказательства, когда в ' +
  'worker есть ключи AI и его доступ одобрен в /decisions.';

/** What /pains reads: pains from the repositories, sources and Russian text from the review. */
export interface PainsSource {
  readonly repositories: Pick<Repositories, 'pains'>;
  readonly painReview: Pick<PainReviewQueries, 'sourceCounts' | 'translations'>;
}

interface RatedPain {
  readonly pain: Pain;
  readonly sources: number;
  readonly rating: number;
  readonly translation?: PainTranslation | undefined;
}

/**
 * /pains (PHASE 06, D-030): open pains by rating, highest first. The rating is computed in code
 * (`painRating`): distinct sources weigh most, then signals, severity and the owner's
 * confirmation. From the database only (§2.13).
 */
export async function painsText(source: PainsSource): Promise<string> {
  return (await painsReply(source)).text;
}

async function topPains(source: PainsSource): Promise<{
  readonly open: number;
  readonly favorites: number;
  readonly top: RatedPain[];
}> {
  const open: Pain[] = [];
  for (const status of ['validated', 'candidate'] as const) {
    open.push(...(await source.repositories.pains.listByStatus(status, { limit: 1_000 })));
  }
  const counts = await source.painReview.sourceCounts(open.map((pain) => pain.id));
  const rated = open.map((pain) => {
    const sources = counts.get(pain.id) ?? 0;
    return { pain, sources, rating: painRating(pain, sources) };
  });
  const sorted = rated
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        b.sources - a.sources ||
        b.pain.updatedAt.localeCompare(a.pain.updatedAt),
    )
    .slice(0, PAINS_SHOWN);
  const translations = await source.painReview.translations(sorted.map((item) => item.pain.id));
  return {
    open: open.length,
    favorites: rated.filter((item) => isFavoritePain(item.sources)).length,
    top: sorted.map((item) => ({ ...item, translation: translations.get(item.pain.id) })),
  };
}

function painButton(text: string, action: string, pain: Pain) {
  return callbackButton(text, `${PAIN_PREFIX}:${action}:${pain.id}:${String(pain.version)}`);
}

function rows<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += BUTTONS_IN_ROW) {
    result.push(items.slice(index, index + BUTTONS_IN_ROW));
  }
  return result;
}

/**
 * /pains with ✅ (confirm) and ✖️ (reject) for each listed pain: five to a row, the ✅ row of a
 * group of five above its ✖️ row.
 */
export async function painsReply(
  source: PainsSource,
): Promise<{ readonly text: string; readonly keyboard?: InlineKeyboard | undefined }> {
  const { open, favorites, top } = await topPains(source);
  if (open === 0) return { text: NO_PAINS_TEXT };
  const confirm = top.map(({ pain }, index) => painButton(`✅ ${String(index + 1)}`, 'ok', pain));
  const reject = top.map(({ pain }, index) => painButton(`✖️ ${String(index + 1)}`, 'x', pain));
  const confirmRows = rows(confirm);
  const rejectRows = rows(reject);
  const keyboard = confirmRows.flatMap((row, index) => [row, rejectRows[index] ?? []]);
  return {
    text:
      `${listText(open, favorites, top)}\n\n` +
      '✅ N — подтвердить: движок возможностей возьмёт боль первой.\n' +
      '✖️ N — отклонить: агент больше не будет её пополнять.',
    keyboard,
  };
}

function title(item: RatedPain): string {
  return item.translation?.titleRu ?? item.pain.title;
}

function audience(item: RatedPain): string {
  return item.translation?.audienceRu ?? item.pain.audience;
}

function listText(open: number, favorites: number, top: readonly RatedPain[]): string {
  const lines = [
    `🧩 Боли · открытых: ${String(open)} · ⭐ фаворитов: ${String(favorites)}`,
    `По рейтингу, сверху — самые подтверждённые${open > PAINS_SHOWN ? ` (показаны ${String(PAINS_SHOWN)})` : ''}. ` +
      `Рейтинг растёт с числом независимых источников; ⭐ фаворит — боль из ` +
      `${String(MIN_SOURCES_FOR_VALIDATED_PAIN)}+ источников.`,
  ];
  if (favorites === 0) {
    lines.push(
      'Фаворитов пока нет: каждая боль найдена в одном источнике. Они появятся, когда та же боль ' +
        'найдётся во втором.',
    );
  }
  lines.push('');
  for (const [index, item] of top.entries()) {
    const { pain, sources, rating } = item;
    const favorite = isFavoritePain(sources);
    lines.push(
      `${String(index + 1)}. ${favorite ? '⭐ ' : ''}${title(item)}`,
      `   Кто: ${audience(item)}`,
      `   Рейтинг ${String(rating)} · источников ${String(sources)} · сигналов ` +
        `${String(pain.signalIds.length)} · ${FREQUENCY_LABELS[pain.frequency]} · тяжесть ` +
        `${String(pain.severity)}/5${pain.ownerConfirmedAt === undefined ? '' : ' · 👍 вы подтвердили'}`,
    );
  }
  return lines.join('\n');
}

export interface PainFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

type PainOutcome =
  | { readonly outcome: 'rejected'; readonly status: 'rejected' | 'archived' }
  | { readonly outcome: 'confirmed' }
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'not_found' };

const ACTIONS = ['ok', 'yok', 'x', 'yx', 'c'] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: string | undefined): value is Action {
  return (ACTIONS as readonly (string | undefined)[]).includes(value);
}

function isOpen(pain: Pain): boolean {
  return pain.status === 'candidate' || pain.status === 'validated';
}

/**
 * ✅ / ✖️ under /pains (PHASE 13, D-030): ask → confirm → one owner command.
 * ✅ marks the pain confirmed by the owner — the opportunity engine takes it first; it does not
 * make it a favorite, which needs evidence from two sources (§2.5). ✖️ makes a candidate
 * `rejected` and a validated pain `archived`; the pain agent only adds signals to open pains.
 */
export async function handlePainButton(
  deps: PainFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [action, rawId, rawVersion] = context.data.split(':');
  const id = painIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (!isAction(action) || !id.success || !Number.isSafeInteger(version)) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { database } = deps;
  const list = async (note?: string) => {
    const reply = await painsReply(database);
    await context.edit(
      note === undefined ? reply.text : `${reply.text}\n\n${note}`,
      reply.keyboard,
    );
  };
  if (action === 'c') {
    await list();
    return;
  }
  if (action === 'x' || action === 'ok') {
    const pain = await database.repositories.pains.getById(id.data);
    if (pain === undefined || pain.version !== version || !isOpen(pain)) {
      await list('⚠️ Список устарел — вот текущий.');
      return;
    }
    if (action === 'ok' && pain.ownerConfirmedAt !== undefined) {
      await context.answer('Уже подтверждена');
      return;
    }
    const translation = (await database.painReview.translations([pain.id])).get(pain.id);
    const header =
      `🧩 «${translation?.titleRu ?? pain.title}»\n` +
      `Кто: ${translation?.audienceRu ?? pain.audience}\n\n`;
    await context.edit(
      action === 'ok'
        ? `${header}❓ Подтвердить эту боль? Движок возможностей возьмёт её первой. ` +
            'Фаворитом она станет, только когда найдётся во втором источнике.'
        : `${header}❓ Отклонить эту боль? Агент больше не будет её пополнять, ` +
            'возможности по ней не появятся.',
      [
        [
          action === 'ok'
            ? painButton('✅ Да, подтвердить', 'yok', pain)
            : painButton('✖️ Да, отклонить', 'yx', pain),
          painButton('Назад', 'c', pain),
        ],
      ],
    );
    return;
  }

  const actor = deps.owner(context.userId);
  let result: PainOutcome;
  try {
    ({ result } = await database.command(
      {
        name: action === 'yok' ? 'pain.confirm' : 'pain.reject',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async (scope): Promise<PainOutcome> => {
        const pain = await scope.repositories.pains.getById(id.data);
        if (pain === undefined) return { outcome: 'not_found' };
        if (pain.version !== version || !isOpen(pain)) return { outcome: 'closed' };
        const domainContext = { actor, at: deps.now() };
        if (action === 'yok') {
          if (pain.ownerConfirmedAt !== undefined) return { outcome: 'closed' };
          await scope.repositories.pains.update(confirmPainByOwner(pain, domainContext), actor);
          return { outcome: 'confirmed' };
        }
        const status = pain.status === 'candidate' ? 'rejected' : 'archived';
        await scope.repositories.pains.update(changePainStatus(pain, status, domainContext), actor);
        return { outcome: 'rejected', status };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'closed' };
  }
  if (result.outcome === 'closed' || result.outcome === 'not_found') {
    await list('⚠️ Боль изменилась одновременно с нажатием — вот текущий список.');
    return;
  }
  if (result.outcome === 'confirmed') {
    context.logger.info('pain confirmed by the owner', { pain_id: id.data });
    await list('👍 Боль подтверждена — движок возможностей возьмёт её первой.');
  } else {
    context.logger.info('pain rejected by the owner', { pain_id: id.data, status: result.status });
    await list(result.status === 'rejected' ? '✖️ Боль отклонена.' : '🗄 Боль убрана в архив.');
  }
  await context.answer('Записано');
}
