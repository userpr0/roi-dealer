import {
  approveMediaAsset,
  formatUsd,
  mediaAssetIdSchema,
  MAX_LANDING_REWRITES,
  rejectMediaAsset,
  startOfUtcMonth,
  toTimestamp,
  usd,
  type Actor,
  type MediaAsset,
  type Money,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database, type Repositories } from '@roi-dealer/database';
import { priceLabel } from '@roi-dealer/media';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import { shorten } from './texts.js';

/*
 * Landings in the panel (PHASE 19a, D-012): the agent's draft arrives as a card with the
 * text, the ads and a private preview link; ✅ approves it, ❌ sends it back for a rewrite.
 * Each press asks for confirmation and is one idempotent owner command (§2.3).
 */

/** Buttons of landing cards: `ma:<a|r|ya|yr|c>:<asset id>:<version>`. */
export const MEDIA_PREFIX = 'ma';
/** The AI task whose calls make up the cost of a landing (PHASE 19a). */
export const LANDING_TASK = 'write-landing';

export interface MediaFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
  /** The public address of the api service (`PUBLIC_API_URL`), for the preview link. */
  readonly publicApiUrl?: string | undefined;
}

const DISCLOSURE_LABELS = {
  in_development: 'пометка «в разработке, оставьте почту»',
  preorder: 'пометка «предзаказ, полный возврат»',
} as const;

const STALE_TEXT = '⚠️ Карточка устарела: лендинг изменился.';

const STATUS_LABELS: Readonly<Record<MediaAsset['status'], string>> = {
  draft: 'ждёт вашей проверки: ✅ или ❌',
  approved: '✅ одобрен',
  rejected: '❌ отклонён',
  released: '🌐 опубликован',
  retired: 'снят',
};

/** The private preview of an asset, when the api's public address is known. */
export function previewUrl(
  asset: MediaAsset,
  publicApiUrl: string | undefined,
): string | undefined {
  if (publicApiUrl === undefined) return undefined;
  return `${publicApiUrl.replace(/\/+$/, '')}/p/${asset.previewToken}`;
}

/** The card of a landing: its words, the price set by code, the ads and the preview link. */
export function landingCardText(
  asset: MediaAsset,
  context: {
    readonly title: string;
    readonly number?: number | undefined;
    readonly publicApiUrl?: string | undefined;
  },
): string {
  const { content } = asset;
  const url = previewUrl(asset, context.publicApiUrl);
  return [
    `🎨 Лендинг для теста${context.number === undefined ? '' : ` №${String(context.number)}`} «${shorten(context.title, 120)}»`,
    '',
    `«${content.headline}»`,
    content.subheadline,
    '',
    'Выгоды:',
    ...content.benefits.map((item) => `• ${item.title} — ${item.text}`),
    '',
    `Цена: ${priceLabel(content.price, content.pricePeriod)} · ${DISCLOSURE_LABELS[content.disclosure]}`,
    `Кнопка: «${content.cta}»`,
    '',
    'Реклама:',
    ...content.ads.map((item, index) => `${String(index + 1)}. ${item.headline} — ${item.body}`),
    '',
    url === undefined
      ? 'Предпросмотр — когда в боте задан PUBLIC_API_URL (адрес сервиса api).'
      : `Предпросмотр: ${url}`,
    `Статус: ${STATUS_LABELS[asset.status]}`,
  ].join('\n');
}

function mediaButton(text: string, action: string, asset: MediaAsset) {
  return callbackButton(text, `${MEDIA_PREFIX}:${action}:${asset.id}:${String(asset.version)}`);
}

export function landingKeyboard(asset: MediaAsset): InlineKeyboard | undefined {
  if (asset.status !== 'draft') return undefined;
  return [[mediaButton('✅ Одобрить', 'a', asset), mediaButton('❌ Переписать', 'r', asset)]];
}

/** The test's title and its number among the active tests, for the card. */
export async function landingCardContext(
  repositories: Pick<Repositories, 'opportunities'>,
  asset: MediaAsset,
  number?: number,
): Promise<{ readonly title: string; readonly number?: number | undefined }> {
  const opportunity = await repositories.opportunities.getById(asset.opportunityId);
  return { title: opportunity?.title ?? 'тест', number };
}

/** Rejected landings of the asset's experiment, for the rewrite note. */
async function rejectedCount(repositories: Repositories, asset: MediaAsset): Promise<number> {
  return (await repositories.mediaAssets.listByExperiments([asset.experimentId])).filter(
    (item) => item.status === 'rejected',
  ).length;
}

type ReviewOutcome =
  | { readonly outcome: 'reviewed'; readonly status: 'approved' | 'rejected' }
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'not_found' };

/** ✅ / ❌ on a landing card: ask → confirm → one owner command; a stale card changes nothing. */
export async function handleMediaButton(
  deps: MediaFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [action, rawId, rawVersion] = context.data.split(':');
  const id = mediaAssetIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (
    !['a', 'r', 'ya', 'yr', 'c'].includes(action ?? '') ||
    !id.success ||
    !Number.isSafeInteger(version)
  ) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { repositories } = deps.database;
  const show = async (asset: MediaAsset, note?: string, keyboard?: InlineKeyboard) => {
    const text = landingCardText(asset, {
      ...(await landingCardContext(repositories, asset)),
      publicApiUrl: deps.publicApiUrl,
    });
    await context.edit(note === undefined ? text : `${text}\n\n${note}`, keyboard);
  };

  if (action === 'a' || action === 'r' || action === 'c') {
    const asset = await repositories.mediaAssets.getById(id.data);
    if (asset === undefined) {
      await context.edit('Лендинг не найден.');
      return;
    }
    if (asset.version !== version || asset.status !== 'draft' || action === 'c') {
      await show(
        asset,
        action === 'c' || asset.version === version ? undefined : STALE_TEXT,
        landingKeyboard(asset),
      );
      return;
    }
    const left = MAX_LANDING_REWRITES - (await rejectedCount(repositories, asset));
    await show(
      asset,
      action === 'a'
        ? '❓ Одобрить лендинг? Опубликовать его можно будет после Release Gate.'
        : left > 0
          ? `❓ Отклонить? Агент напишет новый вариант (осталось переписываний: ${String(left)}).`
          : '❓ Отклонить? Переписываний больше не осталось — лендинг для теста соберите сами.',
      [
        [
          mediaButton(action === 'a' ? '✅ Да, одобрить' : '❌ Да, отклонить', `y${action}`, asset),
          mediaButton('Назад', 'c', asset),
        ],
      ],
    );
    return;
  }

  const actor = deps.owner(context.userId);
  let result: ReviewOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'media.review',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${String(context.updateId)}`,
      },
      async (scope): Promise<ReviewOutcome> => {
        const asset = await scope.repositories.mediaAssets.getById(id.data);
        if (asset === undefined) return { outcome: 'not_found' };
        if (asset.version !== version || asset.status !== 'draft') return { outcome: 'closed' };
        const reviewed =
          action === 'ya'
            ? approveMediaAsset(asset, { actor, at: deps.now() })
            : rejectMediaAsset(asset, { actor, at: deps.now() });
        await scope.repositories.mediaAssets.update(reviewed, actor);
        return { outcome: 'reviewed', status: action === 'ya' ? 'approved' : 'rejected' };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'closed' };
  }
  const asset = await repositories.mediaAssets.getById(id.data);
  if (result.outcome === 'not_found' || asset === undefined) {
    await context.edit('Лендинг не найден.');
    return;
  }
  if (result.outcome === 'closed') {
    await show(asset, STALE_TEXT, landingKeyboard(asset));
    return;
  }
  context.logger.info('landing reviewed by the owner', { status: result.status });
  await show(
    asset,
    result.status === 'approved'
      ? '✅ Одобрено. Дальше — Release Gate и запуск теста в /experiments.'
      : (await rejectedCount(repositories, asset)) <= MAX_LANDING_REWRITES
        ? '❌ Отклонено. Агент напишет новый вариант — карточка придёт сама.'
        : '❌ Отклонено. Переписываний больше нет — лендинг для теста соберите сами.',
  );
  await context.answer(result.status === 'approved' ? 'Одобрено' : 'Отклонено');
}

/** The landing line of a test card (PHASE 19a). */
export function landingLine(asset: MediaAsset | undefined): string {
  if (asset === undefined) {
    return '🎨 Лендинг: пишет агент «Автор лендингов» (доступ — в /decisions)';
  }
  if (asset.status === 'rejected') return '🎨 Лендинг: ❌ отклонён — агент пишет новый вариант';
  return `🎨 Лендинг: ${STATUS_LABELS[asset.status]}`;
}

/**
 * Cost per Approved Asset of the month (D-012): what the `write-landing` calls cost, over the
 * landings of the month the owner approved. Absent without an approved landing.
 */
export async function costPerApprovedLanding(
  database: Pick<Database, 'aiCalls' | 'repositories'>,
  nowMs: number,
): Promise<{
  readonly cost: Money;
  readonly approved: number;
  readonly perApproved?: Money | undefined;
}> {
  const from = toTimestamp(new Date(startOfUtcMonth(nowMs)));
  const to = toTimestamp(new Date(nowMs + 1));
  // Production calls only: evals are the cost of choosing a model, not of a landing.
  const spend = await database.aiCalls.spend({ from, to, task: LANDING_TASK, purpose: 'task' });
  const approved: MediaAsset[] = [];
  for (const status of ['approved', 'released', 'retired'] as const) {
    approved.push(
      ...(await database.repositories.mediaAssets.listByStatus(status, { limit: 1_000 })).filter(
        (item) => item.createdAt >= from,
      ),
    );
  }
  // Micro-USD to cents, rounded up: a cost is never shown lower than it was.
  const cost = usd(Math.ceil(spend.costMicroUsd / 10_000));
  return {
    cost,
    approved: approved.length,
    perApproved:
      approved.length === 0 ? undefined : usd(Math.ceil(cost.amountCents / approved.length)),
  };
}

/** The /economics line of the landings' cost, when there were any this month. */
export async function landingCostLine(
  database: Pick<Database, 'aiCalls' | 'repositories'>,
  nowMs: number,
): Promise<string | undefined> {
  const { cost, approved, perApproved } = await costPerApprovedLanding(database, nowMs);
  if (cost.amountCents === 0 && approved === 0) return undefined;
  return (
    `🎨 Лендинги: AI ${formatUsd(cost)} · одобрено ${String(approved)}` +
    (perApproved === undefined ? '' : ` · ${formatUsd(perApproved)} за одобренный`)
  );
}
