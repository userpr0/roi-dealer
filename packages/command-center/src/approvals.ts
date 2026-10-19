import { createHash } from 'node:crypto';
import {
  approvalRequestIdSchema,
  formatUsd,
  isApprovalExpired,
  resolveApprovalRequest,
  timestampMs,
  type Actor,
  type ApprovalRequest,
  type ApprovalRequestId,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database, type Repositories } from '@roi-dealer/database';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import { applyAccessDecision } from './access.js';
import { applyExperimentLaunchDecision } from './experiments.js';
import { applyPayoutDecision } from './rewards.js';
import { APPROVAL_KIND_LABELS, formatTime, shorten } from './texts.js';

/** Buttons of approval cards: `ap:<action>:<request id>`. */
export const APPROVAL_PREFIX = 'ap';
/** Cards per /decisions reply; the rest are counted. */
export const MAX_CARDS = 10;
const PENDING_SCAN_LIMIT = 200;

type Decision = 'approve' | 'reject';

/** `a`/`r` ask for confirmation, `ya`/`yr` confirm, `c` cancels back to the card. */
const ACTIONS = {
  a: { step: 'ask', decision: 'approve' },
  r: { step: 'ask', decision: 'reject' },
  ya: { step: 'confirm', decision: 'approve' },
  yr: { step: 'confirm', decision: 'reject' },
  c: { step: 'cancel', decision: undefined },
} as const;
type ActionCode = keyof typeof ACTIONS;

/**
 * «Одобрить все доступы»: `all` lists the pending access requests and asks, `yall:<set>` approves
 * exactly the listed set (`accessSetKey`), `xall` cancels. Other requests stay one card each.
 */
const ALL_ACCESS = { ask: 'all', confirm: 'yall', cancel: 'xall' } as const;
/** Access requests one press approves at most; all of them are listed in the question. */
const MAX_BULK_ACCESS = 20;

/** Pending requests that can still be decided, nearest deadline first. */
export async function decidableRequests(
  repositories: Repositories,
  at: Timestamp,
): Promise<ApprovalRequest[]> {
  const pending = await repositories.approvalRequests.listByStatus('pending', {
    limit: PENDING_SCAN_LIMIT,
  });
  return pending
    .filter((request) => !isApprovalExpired(request, at))
    .sort((a, b) => timestampMs(a.expiresAt) - timestampMs(b.expiresAt));
}

function amountText(request: ApprovalRequest): string {
  return request.amount === undefined ? '' : ` · ${formatUsd(request.amount)}`;
}

export function cardText(request: ApprovalRequest): string {
  return [
    `📥 ${APPROVAL_KIND_LABELS[request.kind]}${amountText(request)}`,
    `«${request.title}»`,
    shorten(request.summary, 600),
    `Срок: до ${formatTime(request.expiresAt)} (Киев)`,
  ].join('\n');
}

function button(text: string, action: ActionCode, id: ApprovalRequestId) {
  return callbackButton(text, `${APPROVAL_PREFIX}:${action}:${id}`);
}

export function cardKeyboard(request: ApprovalRequest): InlineKeyboard {
  return [[button('✅ Одобрить', 'a', request.id), button('❌ Отклонить', 'r', request.id)]];
}

function confirmation(request: ApprovalRequest, decision: Decision) {
  const money = request.amount === undefined ? '' : ` на ${formatUsd(request.amount)}`;
  const question =
    decision === 'approve'
      ? `Одобрить «${request.title}»${money}?`
      : `Отклонить «${request.title}»?`;
  return {
    text: `${cardText(request)}\n\n❓ ${question}`,
    keyboard: [
      [
        button(
          decision === 'approve' ? '✅ Да, одобрить' : '❌ Да, отклонить',
          decision === 'approve' ? 'ya' : 'yr',
          request.id,
        ),
        button('Отмена', 'c', request.id),
      ],
    ],
  };
}

/** Why a request cannot be decided any more, or `undefined` when it can. */
function closedText(request: ApprovalRequest, at: Timestamp): string | undefined {
  if (request.status === 'pending' && isApprovalExpired(request, at)) {
    return `⌛ Срок истёк ${formatTime(request.expiresAt)} — решение не принято.`;
  }
  switch (request.status) {
    case 'pending':
      return undefined;
    case 'approved':
      return `✅ Уже одобрено${decidedAt(request)}.`;
    case 'rejected':
      return `❌ Уже отклонено${decidedAt(request)}.`;
    case 'expired':
      return '⌛ Срок запроса истёк.';
    case 'cancelled':
      return '🚫 Запрос отменён.';
  }
}

function decidedAt(request: ApprovalRequest): string {
  return request.resolution === undefined ? '' : ` ${formatTime(request.resolution.decidedAt)}`;
}

const NOTES = {
  granted: '\n🔐 Доступ выдан — /access',
  refused: '\n🔐 Доступ не выдан.',
  launch_approved: '\n🧪 Запуск одобрен: запустите тест и нажмите ▶️ в /experiments.',
  launch_rejected: '\n🧪 Тест вернулся к планированию — /experiments.',
  payout_approved:
    '\n🏆 Выплата одобрена: переведите деньги и отметьте /paid <номер> <ссылка> — /rewards.',
  payout_rejected: '\n🏆 Начисление отменено: вклады снова можно вознаградить — /rewards.',
  none: '',
} as const;

/** The result of a confirmed press, stored with the idempotency key (JSON). */
type ResolveOutcome =
  | {
      readonly outcome: 'resolved';
      readonly status: 'approved' | 'rejected';
      /**
       * What the decision changed: the identity of an `access_grant` request (PHASE 04), the
       * experiment of an `experiment_launch` request (PHASE 15), the reward of a `payout`
       * request (PHASE 17).
       */
      readonly access?: Exclude<keyof typeof NOTES, 'none'> | undefined;
    }
  | { readonly outcome: 'closed'; readonly text: string }
  | { readonly outcome: 'not_found' };

export interface ApprovalFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

/** /decisions: one card per request that waits for the owner. */
export async function sendDecisionCards(
  deps: ApprovalFlowDeps,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const requests = await decidableRequests(deps.database.repositories, deps.now());
  if (requests.length === 0) {
    await reply('📥 Решений, которые ждут вас, нет.');
    return;
  }
  const shown = requests.slice(0, MAX_CARDS);
  const more = requests.length - shown.length;
  await reply(
    `📥 Ждут решения: ${requests.length}. Ближайший срок — первым.` +
      (more > 0 ? `\nПоказаны ${shown.length}; остальные — после решения этих.` : ''),
  );
  const access = accessRequests(requests);
  if (access.length >= 2) {
    await reply(
      `🔐 Доступов ждут: ${access.length}. Их можно одобрить одним решением: бот сначала покажет весь список.`,
      [
        [
          callbackButton(
            `✅ Одобрить все доступы (${access.length})`,
            `${APPROVAL_PREFIX}:${ALL_ACCESS.ask}`,
          ),
        ],
      ],
    );
  }
  for (const request of shown) await reply(cardText(request), cardKeyboard(request));
}

function accessRequests(requests: readonly ApprovalRequest[]): ApprovalRequest[] {
  return requests.filter((request) => request.kind === 'access_grant').slice(0, MAX_BULK_ACCESS);
}

/** A short fingerprint of requests and their versions: a stale question approves nothing. */
function accessSetKey(requests: readonly ApprovalRequest[]): string {
  const versions = requests.map((request) => `${request.id}@${request.version}`).sort();
  return createHash('sha256').update(versions.join(',')).digest('hex').slice(0, 16);
}

async function allAccessQuestion(
  deps: ApprovalFlowDeps,
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const requests = accessRequests(await decidableRequests(deps.database.repositories, deps.now()));
  if (requests.length === 0) return { text: '🔐 Доступов, которые ждут решения, нет.' };
  const list = requests.map((request) => `• «${request.title}» — ${shorten(request.summary, 120)}`);
  return {
    text: [
      `🔐 Одобрить все доступы (${requests.length})?`,
      ...list,
      'Каждый можно приостановить или отозвать позже в /access.',
    ].join('\n'),
    keyboard: [
      [
        callbackButton(
          '✅ Да, одобрить все',
          `${APPROVAL_PREFIX}:${ALL_ACCESS.confirm}:${accessSetKey(requests)}`,
        ),
        callbackButton('Отмена', `${APPROVAL_PREFIX}:${ALL_ACCESS.cancel}`),
      ],
    ],
  };
}

type AllAccessOutcome =
  | { readonly outcome: 'approved'; readonly titles: readonly string[] }
  | { readonly outcome: 'changed' };

/** The buttons of «Одобрить все доступы»: ask with the list → approve exactly it in one command. */
async function handleAllAccessButton(
  deps: ApprovalFlowDeps,
  context: CallbackContext,
  code: string,
  key: string | undefined,
): Promise<void> {
  if (code === ALL_ACCESS.cancel) {
    await context.edit('Ничего не изменено. Доступы по одному — в /decisions.');
    return;
  }
  if (code === ALL_ACCESS.ask) {
    const question = await allAccessQuestion(deps);
    await context.edit(question.text, question.keyboard);
    return;
  }

  const actor = deps.owner(context.userId);
  let result: AllAccessOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'approval.resolve_all_access',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async ({ repositories }): Promise<AllAccessOutcome> => {
        const at = deps.now();
        const requests = accessRequests(await decidableRequests(repositories, at));
        if (requests.length === 0 || accessSetKey(requests) !== key) return { outcome: 'changed' };
        for (const request of requests) {
          const resolved = resolveApprovalRequest(request, { decision: 'approve' }, { actor, at });
          await repositories.approvalRequests.update(resolved, actor);
          await applyAccessDecision(repositories, resolved, actor, at);
        }
        return { outcome: 'approved', titles: requests.map((request) => request.title) };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'changed' };
  }

  if (result.outcome === 'changed') {
    const question = await allAccessQuestion(deps);
    await context.edit(`⚠️ Список доступов изменился.\n\n${question.text}`, question.keyboard);
    return;
  }
  context.logger.info('access requests approved by the owner', { count: result.titles.length });
  await context.edit(
    [
      `✅ Одобрены доступы (${result.titles.length}):`,
      ...result.titles.map((title) => `• «${title}»`),
      '🔐 Доступы выданы — /access',
    ].join('\n'),
  );
  await context.answer('Одобрено');
}

/** Button handler of the cards: ask → confirm → decide, or cancel back to the card. */
export async function handleApprovalButton(
  deps: ApprovalFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [code, rawId] = context.data.split(':');
  if (code === ALL_ACCESS.ask || code === ALL_ACCESS.confirm || code === ALL_ACCESS.cancel) {
    await handleAllAccessButton(deps, context, code, rawId);
    return;
  }
  const id = approvalRequestIdSchema.safeParse(rawId);
  if (code === undefined || !Object.hasOwn(ACTIONS, code) || !id.success) {
    await context.answer('Кнопка устарела');
    return;
  }
  const action = ACTIONS[code as ActionCode];

  if (action.step !== 'confirm') {
    // Showing a question or the card again changes nothing: no confirmation needed.
    const request = await deps.database.repositories.approvalRequests.getById(id.data);
    if (request === undefined) {
      await context.edit('Запрос не найден.');
      return;
    }
    const closed = closedText(request, deps.now());
    if (closed !== undefined) {
      await context.edit(`${cardText(request)}\n\n${closed}`);
      return;
    }
    if (action.step === 'cancel') {
      await context.edit(cardText(request), cardKeyboard(request));
      return;
    }
    const question = confirmation(request, action.decision);
    await context.edit(question.text, question.keyboard);
    return;
  }

  const actor = deps.owner(context.userId);
  let result: ResolveOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'approval.resolve',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async ({ repositories }): Promise<ResolveOutcome> => {
        const request = await repositories.approvalRequests.getById(id.data);
        if (request === undefined) return { outcome: 'not_found' };
        const at = deps.now();
        const closed = closedText(request, at);
        if (closed !== undefined) return { outcome: 'closed', text: closed };
        const resolved = resolveApprovalRequest(
          request,
          { decision: action.decision },
          { actor, at },
        );
        await repositories.approvalRequests.update(resolved, actor);
        const access =
          (await applyAccessDecision(repositories, resolved, actor, at)) ??
          (await applyExperimentLaunchDecision(repositories, resolved, actor, at)) ??
          (await applyPayoutDecision(repositories, resolved, actor, at));
        return {
          outcome: 'resolved',
          status: resolved.status === 'approved' ? 'approved' : 'rejected',
          ...(access === undefined ? {} : { access }),
        };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    context.logger.warn('approval request changed while it was being decided', {
      approval_request_id: id.data,
    });
    result = { outcome: 'closed', text: '⚠️ Запрос изменился одновременно с нажатием.' };
  }

  const request = await deps.database.repositories.approvalRequests.getById(id.data);
  if (result.outcome === 'not_found' || request === undefined) {
    await context.edit('Запрос не найден.');
    return;
  }
  if (result.outcome === 'closed') {
    const closed = closedText(request, deps.now());
    const keyboard = closed === undefined ? cardKeyboard(request) : undefined;
    await context.edit(`${cardText(request)}\n\n${result.text}`, keyboard);
    return;
  }
  context.logger.info('approval request decided by the owner', {
    approval_request_id: id.data,
    status: result.status,
  });
  const verdict =
    (result.status === 'approved'
      ? `✅ Одобрено${decidedAt(request)}${amountText(request)}`
      : `❌ Отклонено${decidedAt(request)}`) + NOTES[result.access ?? 'none'];
  await context.edit(`${cardText(request)}\n\n${verdict}`);
  await context.answer(result.status === 'approved' ? 'Одобрено' : 'Отклонено');
}
