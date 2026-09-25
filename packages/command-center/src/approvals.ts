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

/** The result of a confirmed press, stored with the idempotency key (JSON). */
type ResolveOutcome =
  | { readonly outcome: 'resolved'; readonly status: 'approved' | 'rejected' }
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
  for (const request of shown) await reply(cardText(request), cardKeyboard(request));
}

/** Button handler of the cards: ask → confirm → decide, or cancel back to the card. */
export async function handleApprovalButton(
  deps: ApprovalFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [code, rawId] = context.data.split(':');
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
        return {
          outcome: 'resolved',
          status: resolved.status === 'approved' ? 'approved' : 'rejected',
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
    result.status === 'approved'
      ? `✅ Одобрено${decidedAt(request)}${amountText(request)}`
      : `❌ Отклонено${decidedAt(request)}`;
  await context.edit(`${cardText(request)}\n\n${verdict}`);
  await context.answer(result.status === 'approved' ? 'Одобрено' : 'Отклонено');
}
