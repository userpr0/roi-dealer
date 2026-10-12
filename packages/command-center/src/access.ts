import {
  approvalRequestIdSchema,
  approvePrincipal,
  createApprovalRequest,
  principalIdSchema,
  proposePrincipal,
  reactivatePrincipal,
  revokePrincipal,
  suspendPrincipal,
  timestampMs,
  toTimestamp,
  type Actor,
  type ApprovalRequest,
  type NewPrincipal,
  type Principal,
  type PrincipalStatus,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  ConcurrencyError,
  type AccessLogEntry,
  type Database,
  type Repositories,
} from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { decideAccess, type DenialReason, type Permission } from '@roi-dealer/policies';
import { uuidv7 } from '@roi-dealer/shared';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import { formatTime, shorten } from './texts.js';

/** Buttons of access cards: `pa:<action>:<principal id>`. */
export const ACCESS_PREFIX = 'pa';
/** An access request waits this long for the owner. */
export const ACCESS_REQUEST_TTL_MS = 7 * 24 * 3_600_000;
const MAX_CARDS = 10;
const HOUR_MS = 3_600_000;

/** The platform asks for access on behalf of the integration or agent it sets up. */
const PLATFORM: Actor = { type: 'system', id: 'platform' };

// ---------------------------------------------------------------- Requesting and granting

/**
 * Asks the owner for access for a new agent, integration or member (§2.7): a pending identity
 * and an `access_grant` request, created together by the platform. Used by the phases that
 * introduce integrations (PHASE 05) and agents (PHASE 10).
 */
export async function requestAccess(
  database: Database,
  data: NewPrincipal,
  options: { readonly at: Timestamp; readonly correlationId?: string | undefined },
): Promise<{ principal: Principal; request: ApprovalRequest }> {
  const principal = proposePrincipal(data, {
    id: principalIdSchema.parse(uuidv7()),
    actor: PLATFORM,
    at: options.at,
  });
  const request = createApprovalRequest(
    {
      kind: 'access_grant',
      title: `Доступ: ${data.displayName}`,
      summary: `${actorText(data.actor)}. ${data.purpose}`,
      subject: { type: 'principal', id: principal.id },
      expiresAt: toTimestamp(new Date(timestampMs(options.at) + ACCESS_REQUEST_TTL_MS)),
    },
    { id: approvalRequestIdSchema.parse(uuidv7()), actor: PLATFORM, at: options.at },
  );
  await database.transaction(
    async ({ repositories }) => {
      await repositories.principals.insert(principal);
      await repositories.approvalRequests.insert(request);
    },
    { correlationId: options.correlationId },
  );
  return { principal, request };
}

/**
 * Applies the owner's answer to an `access_grant` request in the same command: approval grants
 * the identity, rejection revokes it. Returns what happened, or `undefined` for other requests.
 */
export async function applyAccessDecision(
  repositories: Repositories,
  request: ApprovalRequest,
  actor: Actor,
  at: Timestamp,
): Promise<'granted' | 'refused' | undefined> {
  if (request.kind !== 'access_grant' || request.subject?.type !== 'principal') return undefined;
  const principal = await repositories.principals.getById(
    principalIdSchema.parse(request.subject.id),
  );
  if (principal?.status !== 'pending') return undefined;
  const granted = request.status === 'approved';
  const next = granted
    ? approvePrincipal(principal, { actor, at })
    : revokePrincipal(principal, { actor, at });
  await repositories.principals.update(next, actor);
  return granted ? 'granted' : 'refused';
}

// ---------------------------------------------------------------- Texts

const ACTOR_KIND: Readonly<Record<string, string>> = {
  agent: '🤖 Агент',
  integration: '🔌 Интеграция',
  member: '👤 Участник',
};

function actorText(actor: Actor): string {
  return `${ACTOR_KIND[actor.type] ?? actor.type} ${shorten(actor.id, 60)}`;
}

const STATUS_TEXT: Readonly<Record<PrincipalStatus, string>> = {
  pending: '⏳ ждёт решения в /decisions',
  active: '🟢 активен',
  suspended: '⏸ приостановлен',
  revoked: '⛔ отозван',
};

export function principalCardText(principal: Principal): string {
  return [
    `${actorText(principal.actor)} — «${principal.displayName}»`,
    `Назначение: ${shorten(principal.purpose, 300)}`,
    `Статус: ${STATUS_TEXT[principal.status]} с ${formatTime(principal.updatedAt)}`,
  ].join('\n');
}

/** `s` suspend, `a` return, `r` revoke ask for confirmation; `y*` confirm; `c` cancels. */
const ACTIONS = {
  s: { step: 'ask', change: 'suspend' },
  a: { step: 'ask', change: 'return' },
  r: { step: 'ask', change: 'revoke' },
  ys: { step: 'confirm', change: 'suspend' },
  ya: { step: 'confirm', change: 'return' },
  yr: { step: 'confirm', change: 'revoke' },
  c: { step: 'cancel', change: undefined },
} as const;
type ActionCode = keyof typeof ACTIONS;
type Change = 'suspend' | 'return' | 'revoke';

const CHANGES: Readonly<
  Record<
    Change,
    { from: readonly PrincipalStatus[]; question: string; confirm: string; done: string }
  >
> = {
  suspend: {
    from: ['active'],
    question: 'Приостановить доступ? Все записи от этого имени будут отклоняться.',
    confirm: '⏸ Да, приостановить',
    done: '⏸ Доступ приостановлен.',
  },
  return: {
    from: ['suspended'],
    question: 'Вернуть доступ?',
    confirm: '▶️ Да, вернуть',
    done: '▶️ Доступ возвращён.',
  },
  revoke: {
    from: ['active', 'suspended'],
    question: 'Отозвать доступ навсегда? Вернуть его будет нельзя.',
    confirm: '⛔ Да, отозвать',
    done: '⛔ Доступ отозван.',
  },
};

function button(text: string, action: ActionCode, principal: Principal) {
  return callbackButton(text, `${ACCESS_PREFIX}:${action}:${principal.id}`);
}

export function principalKeyboard(principal: Principal): InlineKeyboard | undefined {
  if (principal.status === 'active') {
    return [[button('⏸ Приостановить', 's', principal), button('⛔ Отозвать', 'r', principal)]];
  }
  if (principal.status === 'suspended') {
    return [[button('▶️ Вернуть', 'a', principal), button('⛔ Отозвать', 'r', principal)]];
  }
  return undefined;
}

// ---------------------------------------------------------------- /access

export interface AccessFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

/** 🔐 /access: who may write into the system, and refused attempts of the last 7 days. */
export async function sendAccessOverview(
  deps: AccessFlowDeps,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const { repositories, access } = deps.database;
  const [active, suspended, pending] = await Promise.all([
    repositories.principals.listByStatus('active', { limit: 100 }),
    repositories.principals.listByStatus('suspended', { limit: 100 }),
    repositories.principals.listByStatus('pending', { limit: 100 }),
  ]);
  const nowMs = timestampMs(deps.now());
  const week = {
    from: toTimestamp(new Date(nowMs - 7 * 24 * HOUR_MS)),
    to: toTimestamp(new Date(nowMs + 1)),
  };
  const [denied, [last]] = await Promise.all([
    access.count({ ...week, decision: 'denied' }),
    access.list({ ...week, decision: 'denied', limit: 1 }),
  ]);

  const cards = [...active, ...suspended];
  await reply(
    [
      '🔐 Доступы к записи в систему',
      `Активных: ${active.length} · приостановленных: ${suspended.length}` +
        (pending.length > 0 ? ` · ждут решения: ${pending.length} → /decisions` : ''),
      cards.length === 0
        ? 'Агентов, интеграций и участников пока нет — пишут только вы и система.'
        : '',
      denied === 0 || last === undefined
        ? 'Отклонённых попыток за 7 дней нет.'
        : `⚠️ Отклонённых попыток за 7 дней: ${denied}; последняя ${formatTime(last.occurredAt)} — ${shorten(last.actorId, 40)} (${last.reason ?? '?'})`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );
  for (const principal of cards.slice(0, MAX_CARDS)) {
    await reply(principalCardText(principal), principalKeyboard(principal));
  }
}

type ChangeOutcome =
  | { readonly outcome: 'changed'; readonly status: PrincipalStatus }
  | { readonly outcome: 'unchanged'; readonly status: PrincipalStatus }
  | { readonly outcome: 'not_found' };

/** Buttons of access cards: ask → confirm → change, or cancel back to the card. */
export async function handleAccessButton(
  deps: AccessFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [code, rawId] = context.data.split(':');
  const id = principalIdSchema.safeParse(rawId);
  if (code === undefined || !Object.hasOwn(ACTIONS, code) || !id.success) {
    await context.answer('Кнопка устарела');
    return;
  }
  const action = ACTIONS[code as ActionCode];
  const stored = await deps.database.repositories.principals.getById(id.data);
  if (stored === undefined) {
    await context.edit('Доступ не найден.');
    return;
  }
  if (action.step === 'cancel' || action.change === undefined) {
    await context.edit(principalCardText(stored), principalKeyboard(stored));
    return;
  }
  const change = CHANGES[action.change];
  if (action.step === 'ask') {
    if (!change.from.includes(stored.status)) {
      await context.edit(principalCardText(stored), principalKeyboard(stored));
      return;
    }
    await context.edit(`${principalCardText(stored)}\n\n❓ ${change.question}`, [
      [button(change.confirm, `y${code}` as ActionCode, stored), button('Отмена', 'c', stored)],
    ]);
    return;
  }

  const actor = deps.owner(context.userId);
  const changeName = action.change;
  let result: ChangeOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: `access.${changeName}`,
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async ({ repositories }): Promise<ChangeOutcome> => {
        const principal = await repositories.principals.getById(id.data);
        if (principal === undefined) return { outcome: 'not_found' };
        if (!change.from.includes(principal.status)) {
          return { outcome: 'unchanged', status: principal.status };
        }
        const at = deps.now();
        const next =
          changeName === 'suspend'
            ? suspendPrincipal(principal, { actor, at })
            : changeName === 'return'
              ? reactivatePrincipal(principal, { actor, at })
              : revokePrincipal(principal, { actor, at });
        await repositories.principals.update(next, actor);
        return { outcome: 'changed', status: next.status };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'unchanged', status: stored.status };
  }

  const principal = await deps.database.repositories.principals.getById(id.data);
  if (result.outcome === 'not_found' || principal === undefined) {
    await context.edit('Доступ не найден.');
    return;
  }
  context.logger.info('access changed by the owner', {
    principal_id: principal.id,
    change: changeName,
    outcome: result.outcome,
  });
  const note =
    result.outcome === 'changed' ? change.done : 'Уже изменено — показываю текущее состояние.';
  await context.edit(`${principalCardText(principal)}\n\n${note}`, principalKeyboard(principal));
}

// ---------------------------------------------------------------- Audit

/** A message or button press the router refused (unknown sender or not a private chat). */
export interface RefusedAttempt {
  readonly userId: number | undefined;
  readonly reason: Extract<DenialReason, 'not_owner' | 'not_private_chat'>;
  readonly updateId: number;
}

export interface AccessAudit {
  /**
   * Checks and records a view or action of the owner in the panel. Returns whether it is
   * allowed; recording failures are logged, never thrown.
   */
  allow(telegramUserId: number, updateId: number, permission: Permission): Promise<boolean>;
  /** Records an attempt the router refused; at most once per sender per 10 minutes. */
  refused(attempt: RefusedAttempt): Promise<void>;
}

/** One record per unknown sender per window protects the log from floods. */
export const REFUSED_THROTTLE_MS = 10 * 60_000;
const MAX_TRACKED_SENDERS = 1_000;

export function createAccessAudit(deps: {
  readonly database: Database;
  readonly logger: Logger;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}): AccessAudit {
  const lastRecorded = new Map<string, number>();

  async function record(entry: AccessLogEntry): Promise<void> {
    try {
      await deps.database.access.record(entry);
    } catch (error) {
      deps.logger.warn('access log entry not recorded', { error, permission: entry.permission });
    }
  }

  return {
    async allow(telegramUserId, updateId, permission) {
      const actor = deps.owner(telegramUserId);
      const decision = decideAccess(actor, permission, undefined);
      await record({
        occurredAt: deps.now(),
        channel: 'telegram',
        actorType: actor.type,
        actorId: actor.id,
        permission,
        decision: decision.allowed ? 'allowed' : 'denied',
        reason: decision.allowed ? undefined : decision.reason,
        correlationId: `tg-update-${updateId}`,
      });
      return decision.allowed;
    },

    async refused({ userId, reason, updateId }) {
      const actorId = `telegram:${userId ?? 'unknown'}`;
      const nowMs = timestampMs(deps.now());
      const previous = lastRecorded.get(actorId);
      if (previous !== undefined && nowMs - previous < REFUSED_THROTTLE_MS) return;
      if (lastRecorded.size >= MAX_TRACKED_SENDERS) {
        for (const [sender, at] of lastRecorded) {
          if (nowMs - at >= REFUSED_THROTTLE_MS) lastRecorded.delete(sender);
        }
        if (lastRecorded.size >= MAX_TRACKED_SENDERS) lastRecorded.clear();
      }
      lastRecorded.set(actorId, nowMs);
      await record({
        occurredAt: deps.now(),
        channel: 'telegram',
        actorId,
        permission: 'panel.use',
        decision: 'denied',
        reason,
        correlationId: `tg-update-${updateId}`,
      });
    },
  };
}
