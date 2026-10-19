import {
  approveMediaAsset,
  DomainError,
  formatUsd,
  mediaAssetIdSchema,
  MAX_LANDING_REWRITES,
  rejectMediaAsset,
  releaseGate,
  releaseMediaAsset,
  RELEASE_OWNER_CHECKS,
  startOfUtcMonth,
  toTimestamp,
  usd,
  type Actor,
  type MediaAsset,
  type Money,
  type ReleaseCodeCheck,
  type ReleaseFacts,
  type ReleaseOwnerCheck,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database, type Repositories } from '@roi-dealer/database';
import { isStaticPage, priceLabel, renderLanding } from '@roi-dealer/media';
import { landingPath, MEASUREMENT_NOTE, SITE_TRACKER } from '@roi-dealer/site';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import { shorten } from './texts.js';

/*
 * Landings in the panel (PHASE 19a, D-012): the agent's draft arrives as a card with the
 * text, the ads and a private preview link; ✅ approves it, ❌ sends it back for a rewrite.
 * An approved landing passes the Release Gate and is published (PHASE 21, §7.2). Each press
 * asks for confirmation and is one idempotent owner command (§2.3).
 */

/** Buttons of landing cards: `ma:<a|r|g|ya|yr|yg|c>:<asset id>:<version>`. */
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

/** The Release Gate's checks in the owner's words: what is checked and how to fix it. */
export const RELEASE_CHECK_LABELS: Readonly<
  Record<ReleaseCodeCheck, { readonly label: string; readonly fix: string }>
> = {
  page_approved: { label: 'Лендинг одобрен вами', fix: 'одобрите лендинг ✅' },
  launch_approved: {
    label: 'Запуск теста одобрен: бюджет, stop-loss, лимиты',
    fix: 'запросите запуск в /experiments и одобрите в /decisions',
  },
  metric_fixed: {
    label: 'Метрика успеха и stop-loss заданы до запуска',
    fix: 'у теста нет метрики воронки или stop-loss',
  },
  honest_checks: {
    label: 'Чек-лист честной проверки подтверждён',
    fix: 'подтвердите чек-лист в /experiments',
  },
  tracking: {
    label: 'Счётчик воронки работает',
    fix: 'одобрите «Доступ: Сайт тестов» в /decisions (появится, когда запущен сервис api)',
  },
  page_static: {
    label: 'Страница без скриптов и внешних адресов',
    fix: 'страница не прошла проверку — напишите Claude',
  },
  payment_flow: {
    label: 'Оплата проверена тестовым платежом',
    fix: 'подключите приём оплат и проведите тестовый платёж (PHASE 20b)',
  },
  refund_terms: {
    label: 'На странице — условия полного возврата',
    fix: 'перепишите лендинг ❌',
  },
};

/** What the owner confirms at the gate (§7.2: Early User Crash Test, no known blockers). */
export const RELEASE_OWNER_LABELS: Readonly<Record<ReleaseOwnerCheck, string>> = {
  crash_test:
    '2–3 человека открыли предпросмотр без подсказок и поняли, что предлагается и что будет после кнопки',
  no_blockers: 'Страница проверена на телефоне: текст, цена и кнопка верны, блокирующих ошибок нет',
};

/** The public page of a released landing, when the api's public address is known. */
export function publicUrl(
  asset: Pick<MediaAsset, 'slug'>,
  publicApiUrl: string | undefined,
): string | undefined {
  if (publicApiUrl === undefined) return undefined;
  return `${publicApiUrl.replace(/\/+$/, '')}${landingPath(asset)}`;
}

/** An address for ads: the page with UTM tags of the hypothesis's channel. */
export function adUrl(pageUrl: string, channel: string): string {
  const source = /[a-z0-9]+/.exec(channel.toLowerCase())?.[0] ?? 'ads';
  return `${pageUrl}?utm_source=${source}&utm_medium=cpc&utm_campaign=launch`;
}

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
  const page = publicUrl(asset, context.publicApiUrl);
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
    ...(asset.status === 'released'
      ? [`Страница: ${page ?? `<адрес сервиса api>${landingPath(asset)}`}`]
      : []),
    `Статус: ${STATUS_LABELS[asset.status]}`,
  ].join('\n');
}

function mediaButton(text: string, action: string, asset: MediaAsset) {
  return callbackButton(text, `${MEDIA_PREFIX}:${action}:${asset.id}:${String(asset.version)}`);
}

export function landingKeyboard(asset: MediaAsset): InlineKeyboard | undefined {
  if (asset.status === 'approved') return [[mediaButton('🚦 Release Gate', 'g', asset)]];
  if (asset.status !== 'draft') return undefined;
  return [[mediaButton('✅ Одобрить', 'a', asset), mediaButton('❌ Переписать', 'r', asset)]];
}

/** The facts of the Release Gate from the database (PHASE 21). */
export async function releaseFacts(
  scope: Pick<Database, 'repositories'>,
  asset: MediaAsset,
): Promise<ReleaseFacts | undefined> {
  const { repositories } = scope;
  const experiment = await repositories.experiments.getById(asset.experimentId);
  const hypothesis = await repositories.hypotheses.getById(asset.hypothesisId);
  if (experiment === undefined || hypothesis === undefined) return undefined;
  const tracker = await repositories.principals.getByActor(SITE_TRACKER);
  const html = renderLanding(asset.content, {
    mode: 'public',
    ctaHref: landingPath(asset, 'go'),
    footerNote: MEASUREMENT_NOTE,
  });
  return {
    asset,
    experiment,
    hypothesis,
    trackerActive: tracker?.status === 'active',
    pageStatic: isStaticPage(html),
    // Payments arrive with PHASE 20b; until then a paid preorder is not released.
    checkoutReady: false,
  };
}

/** The gate as the owner reads it: ✅ / ❌ per check with the fix. */
export function releaseGateText(facts: ReleaseFacts): { text: string; passed: boolean } {
  const items = releaseGate(facts);
  const lines = items.map((item) => {
    const words = RELEASE_CHECK_LABELS[item.check];
    return item.passed ? `✅ ${words.label}` : `❌ ${words.label} — ${words.fix}`;
  });
  const passed = items.every((item) => item.passed);
  return {
    passed,
    text: [
      '🚦 Release Gate (§7.2) — перед публичным трафиком:',
      ...lines,
      ...(passed
        ? [
            '',
            'Подтвердите сами:',
            ...RELEASE_OWNER_CHECKS.map((check) => `• ${RELEASE_OWNER_LABELS[check]}`),
            '',
            '❓ Всё так? Страница станет публичной; просмотры и нажатия пойдут в воронку, когда тест запущен.',
          ]
        : ['', 'Исправьте ❌ и откройте Release Gate снова.']),
    ].join('\n'),
  };
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
  | { readonly outcome: 'reviewed'; readonly status: 'approved' | 'rejected' | 'released' }
  | { readonly outcome: 'blocked' }
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'not_found' };

/**
 * ✅ / ❌ / 🚦 on a landing card: ask → confirm → one owner command; a stale card changes
 * nothing. The release re-checks the gate inside the command.
 */
export async function handleMediaButton(
  deps: MediaFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [action, rawId, rawVersion] = context.data.split(':');
  const id = mediaAssetIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (
    !['a', 'r', 'g', 'ya', 'yr', 'yg', 'c'].includes(action ?? '') ||
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

  if (action === 'g') {
    const asset = await repositories.mediaAssets.getById(id.data);
    if (asset === undefined) {
      await context.edit('Лендинг не найден.');
      return;
    }
    const facts =
      asset.status === 'approved' ? await releaseFacts(deps.database, asset) : undefined;
    if (asset.version !== version || facts === undefined) {
      await show(asset, STALE_TEXT, landingKeyboard(asset));
      return;
    }
    const gate = releaseGateText(facts);
    await show(
      asset,
      gate.text,
      gate.passed
        ? [[mediaButton('🚀 Да, выпустить', 'yg', asset), mediaButton('Назад', 'c', asset)]]
        : [[mediaButton('Назад', 'c', asset)]],
    );
    return;
  }

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
        if (action === 'yg') {
          if (asset.version !== version || asset.status !== 'approved')
            return { outcome: 'closed' };
          const facts = await releaseFacts(scope, asset);
          if (facts === undefined) return { outcome: 'not_found' };
          let released: MediaAsset;
          try {
            released = releaseMediaAsset(asset, facts, RELEASE_OWNER_CHECKS, {
              actor,
              at: deps.now(),
            });
          } catch (error) {
            if (error instanceof DomainError && error.code === 'invariant_violation') {
              return { outcome: 'blocked' };
            }
            throw error;
          }
          await scope.repositories.mediaAssets.update(released, actor);
          return { outcome: 'reviewed', status: 'released' };
        }
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
  if (result.outcome === 'blocked') {
    const facts = await releaseFacts(deps.database, asset);
    await show(asset, facts === undefined ? STALE_TEXT : releaseGateText(facts).text, [
      [mediaButton('Назад', 'c', asset)],
    ]);
    return;
  }
  context.logger.info('landing reviewed by the owner', { status: result.status });
  await show(asset, await resultNote(deps, asset, result.status), landingKeyboard(asset));
  await context.answer(
    result.status === 'approved'
      ? 'Одобрено'
      : result.status === 'released'
        ? 'Выпущено'
        : 'Отклонено',
  );
}

async function resultNote(
  deps: MediaFlowDeps,
  asset: MediaAsset,
  status: 'approved' | 'rejected' | 'released',
): Promise<string> {
  const { repositories } = deps.database;
  if (status === 'approved') {
    return '✅ Одобрено. Дальше — 🚦 Release Gate: проверка перед публикацией.';
  }
  if (status === 'rejected') {
    return (await rejectedCount(repositories, asset)) <= MAX_LANDING_REWRITES
      ? '❌ Отклонено. Агент напишет новый вариант — карточка придёт сама.'
      : '❌ Отклонено. Переписываний больше нет — лендинг для теста соберите сами.';
  }
  const page = publicUrl(asset, deps.publicApiUrl);
  const hypothesis = await repositories.hypotheses.getById(asset.hypothesisId);
  return [
    page === undefined
      ? `🌐 Опубликовано: <адрес сервиса api>${landingPath(asset)} (задайте PUBLIC_API_URL у бота, чтобы видеть ссылку).`
      : `🌐 Опубликовано: ${page}`,
    ...(page === undefined || hypothesis === undefined
      ? []
      : [`Ссылка для рекламы: ${adUrl(page, hypothesis.channel)}`]),
    'Просмотры и нажатия считаются, когда тест идёт: ▶️ «Тест запущен» в /experiments.',
  ].join('\n');
}

/** The landing line of a test card (PHASE 19a). */
export function landingLine(asset: MediaAsset | undefined): string {
  if (asset === undefined) {
    return '🎨 Лендинг: пишет агент «Автор лендингов» (доступ — в /decisions)';
  }
  if (asset.status === 'rejected') return '🎨 Лендинг: ❌ отклонён — агент пишет новый вариант';
  if (asset.status === 'approved') return '🎨 Лендинг: ✅ одобрен — дальше 🚦 Release Gate';
  if (asset.status === 'released') return `🎨 Лендинг: 🌐 опубликован — ${landingPath(asset)}`;
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
