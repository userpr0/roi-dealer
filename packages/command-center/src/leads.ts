import { randomBytes } from 'node:crypto';
import { eraseContacts, forgetEmail, normalizeEmail } from '@roi-dealer/crm';
import { ConcurrencyError, type Database, type TransactionScope } from '@roi-dealer/database';
import {
  changeLeadStatus,
  leadIdSchema,
  recordCustomerOutcome,
  timestampMs,
  type Actor,
  type CustomerOutcome,
  type Lead,
  type LeadStatus,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboard,
} from '@roi-dealer/telegram';
import { experimentNumbers } from './experiments.js';
import { formatTime, shorten } from './texts.js';

/*
 * Leads in the panel (PHASE 20): a sign-up arrives as a notice; /leads shows the open ones with
 * their email (the owner contacts people outside the system) and moves them — contacted,
 * customer, lost — and records the customer's outcome. /forget deletes a person's email on
 * request. Every change asks for confirmation and is one idempotent owner command.
 */

/** Buttons of lead cards: `ld:<action>:<lead id>:<version>`. */
export const LEADS_PREFIX = 'ld';
/** Confirmations of /forget: `fg:<y|n>:<nonce>`. */
export const FORGET_PREFIX = 'fg';
/** Open leads shown by /leads at once. */
export const MAX_LEAD_CARDS = 10;
const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;

export interface LeadFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

const STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  new: '🆕 новая',
  contacted: '✉️ связались',
  customer: '💰 клиент',
  lost: '✖️ не подходит',
};

const OUTCOME_LABELS: Readonly<Record<CustomerOutcome, string>> = {
  achieved: '✅ результат достигнут',
  partial: '◐ частично',
  not_achieved: '❌ не достигнут',
};

type Step =
  | { readonly kind: 'status'; readonly to: 'contacted' | 'customer' | 'lost' }
  | { readonly kind: 'outcome'; readonly outcome: CustomerOutcome }
  | { readonly kind: 'forget' };

/** What each button does, with its question and confirm button. */
const STEPS: Readonly<
  Record<string, { readonly step: Step; readonly question: string; readonly confirm: string }>
> = {
  c: {
    step: { kind: 'status', to: 'contacted' },
    question: '❓ Отметить: вы связались с человеком?',
    confirm: '✉️ Да, связался',
  },
  k: {
    step: { kind: 'status', to: 'customer' },
    question: '❓ Отметить клиентом? Дальше — итог клиента: получил ли он обещанный результат.',
    confirm: '💰 Да, клиент',
  },
  l: {
    step: { kind: 'status', to: 'lost' },
    question: '❓ Отметить «не подходит»? Почту можно удалить отдельно.',
    confirm: '✖️ Да, не подходит',
  },
  oa: {
    step: { kind: 'outcome', outcome: 'achieved' },
    question: '❓ Клиент получил обещанный результат? Это добавит шаг воронки «результат».',
    confirm: '✅ Да, достигнут',
  },
  op: {
    step: { kind: 'outcome', outcome: 'partial' },
    question: '❓ Результат достигнут частично?',
    confirm: '◐ Да, частично',
  },
  on: {
    step: { kind: 'outcome', outcome: 'not_achieved' },
    question: '❓ Результат не достигнут?',
    confirm: '❌ Да, не достигнут',
  },
  f: {
    step: { kind: 'forget' },
    question:
      '❓ Удалить почту этого человека? Её нельзя будет вернуть; заявка останется в цифрах.',
    confirm: '🗑 Да, удалить',
  },
};

interface LeadContext {
  readonly number?: number | undefined;
  readonly title: string;
  /** `undefined` when erased. */
  readonly email?: string | undefined;
}

export function leadCardText(lead: Lead, context: LeadContext): string {
  const test = context.number === undefined ? 'тест' : `тест №${String(context.number)}`;
  return [
    `📥 Заявка · ${test} «${shorten(context.title, 100)}» · ${formatTime(lead.createdAt)}`,
    `Почта: ${lead.contactErasedAt !== undefined ? 'удалена' : (context.email ?? '—')}`,
    `Канал: ${shorten(lead.channel, 60)}${lead.utmSource === undefined ? '' : ` · utm: ${lead.utmSource}`}`,
    `Статус: ${STATUS_LABELS[lead.status]}` +
      (lead.outcome === undefined ? '' : ` · итог: ${OUTCOME_LABELS[lead.outcome]}`),
  ].join('\n');
}

function leadButton(text: string, action: string, lead: Lead) {
  return callbackButton(text, `${LEADS_PREFIX}:${action}:${lead.id}:${String(lead.version)}`);
}

export function leadKeyboard(lead: Lead): InlineKeyboard | undefined {
  const rows: ReturnType<typeof callbackButton>[][] = [];
  if (lead.status === 'new' || lead.status === 'contacted') {
    rows.push([
      ...(lead.status === 'new' ? [leadButton('✉️ Связался', 'c', lead)] : []),
      leadButton('💰 Клиент', 'k', lead),
      leadButton('✖️ Не подходит', 'l', lead),
    ]);
  }
  if (lead.status === 'customer' && lead.outcome === undefined) {
    rows.push([
      leadButton('✅ Результат', 'oa', lead),
      leadButton('◐ Частично', 'op', lead),
      leadButton('❌ Нет', 'on', lead),
    ]);
  }
  if (lead.contactErasedAt === undefined) rows.push([leadButton('🗑 Удалить почту', 'f', lead)]);
  return rows.length === 0 ? undefined : rows;
}

async function contextOf(
  database: Pick<Database, 'repositories' | 'leadContacts'>,
  leads: readonly Lead[],
  actor: Actor,
): Promise<Map<Lead['id'], LeadContext>> {
  const numbers = await experimentNumbers(database.repositories);
  const emails = await database.leadContacts.emails(
    leads.map((lead) => lead.id),
    actor,
  );
  const titles = new Map<string, string>();
  const result = new Map<Lead['id'], LeadContext>();
  for (const lead of leads) {
    if (!titles.has(lead.opportunityId)) {
      const opportunity = await database.repositories.opportunities.getById(lead.opportunityId);
      titles.set(lead.opportunityId, opportunity?.title ?? 'тест');
    }
    result.set(lead.id, {
      number: numbers.get(lead.experimentId),
      title: titles.get(lead.opportunityId) ?? 'тест',
      email: emails.get(lead.id),
    });
  }
  return result;
}

/** /leads: the open leads, newest first, with their email and buttons. */
export async function sendLeads(deps: LeadFlowDeps, context: CommandContext): Promise<void> {
  const actor = deps.owner(context.userId);
  const open = await deps.database.repositories.leads.listOpen({ limit: 1_000 });
  if (open.length === 0) {
    await context.reply(
      '📥 Открытых заявок нет.\n\nЗаявки приходят с выпущенных страниц тестов (форма с почтой ' +
        'и согласием), пока тест идёт. Удалить почту человека по его просьбе — /forget <почта>.',
    );
    return;
  }
  const count = (status: LeadStatus) => open.filter((lead) => lead.status === status).length;
  const shown = open.slice(0, MAX_LEAD_CARDS);
  await context.reply(
    `📥 Заявки: новых ${String(count('new'))} · связались ${String(count('contacted'))} · ` +
      `клиентов без итога ${String(count('customer'))}` +
      (open.length > shown.length ? ` · показаны ${String(shown.length)} новых` : '') +
      '\nПишите людям сами; удалить почту по просьбе — /forget <почта>.',
  );
  const contexts = await contextOf(deps.database, shown, actor);
  for (const lead of shown) {
    const leadContext = contexts.get(lead.id) ?? { title: 'тест' };
    await context.reply(leadCardText(lead, leadContext), leadKeyboard(lead));
  }
}

type LeadOutcome =
  | { readonly outcome: 'done'; readonly text: string }
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'not_found' };

const STALE_TEXT = '⚠️ Карточка устарела: заявка изменилась. Откройте /leads.';

/** Applies a confirmed step inside the owner's command. */
async function apply(
  scope: TransactionScope,
  lead: Lead,
  step: Step,
  actor: Actor,
  at: Timestamp,
): Promise<LeadOutcome> {
  const context = { actor, at };
  switch (step.kind) {
    case 'status':
      if (lead.status === step.to || !['new', 'contacted'].includes(lead.status)) {
        return { outcome: 'closed' };
      }
      await scope.repositories.leads.update(changeLeadStatus(lead, step.to, context), actor);
      return { outcome: 'done', text: `Записано: ${STATUS_LABELS[step.to]}.` };
    case 'outcome': {
      if (lead.status !== 'customer' || lead.outcome !== undefined) return { outcome: 'closed' };
      await scope.repositories.leads.update(
        recordCustomerOutcome(lead, step.outcome, context),
        actor,
      );
      if (step.outcome === 'achieved') {
        // The funnel's `outcome` step of the test (§7.1 Step G).
        await scope.funnel.record(
          [
            {
              experimentId: lead.experimentId,
              hypothesisId: lead.hypothesisId,
              stage: 'outcome',
              quantity: 1,
              channel: lead.channel,
              utm: lead.utmSource === undefined ? {} : { source: lead.utmSource },
              occurredAt: at,
              source: 'owner_report',
            },
          ],
          actor,
        );
      }
      return { outcome: 'done', text: `Итог клиента записан: ${OUTCOME_LABELS[step.outcome]}.` };
    }
    case 'forget':
      if (lead.contactErasedAt !== undefined) return { outcome: 'closed' };
      await eraseContacts(scope, [lead.id], actor, at);
      return { outcome: 'done', text: '🗑 Почта удалена.' };
  }
}

/** Buttons of lead cards: ask → confirm → one owner command; a stale card changes nothing. */
export async function handleLeadButton(
  deps: LeadFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [rawAction = '', rawId, rawVersion] = context.data.split(':');
  const confirmed = rawAction.startsWith('y');
  const action = confirmed ? rawAction.slice(1) : rawAction;
  const id = leadIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  const entry = STEPS[action];
  if ((entry === undefined && action !== 'b') || !id.success || !Number.isSafeInteger(version)) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { database } = deps;
  const actor = deps.owner(context.userId);
  const show = async (lead: Lead, note?: string, keyboard?: InlineKeyboard) => {
    const leadContext = (await contextOf(database, [lead], actor)).get(lead.id) ?? {
      title: 'тест',
    };
    const text = leadCardText(lead, leadContext);
    await context.edit(note === undefined ? text : `${text}\n\n${note}`, keyboard);
  };

  if (!confirmed) {
    const lead = await database.repositories.leads.getById(id.data);
    if (lead === undefined) {
      await context.edit('Заявка не найдена.');
      return;
    }
    if (lead.version !== version || entry === undefined) {
      await show(lead, lead.version === version ? undefined : STALE_TEXT, leadKeyboard(lead));
      return;
    }
    await show(lead, entry.question, [
      [leadButton(entry.confirm, `y${action}`, lead), leadButton('Назад', 'b', lead)],
    ]);
    return;
  }

  if (entry === undefined) {
    await context.answer('Кнопка устарела');
    return;
  }
  let result: LeadOutcome;
  try {
    ({ result } = await database.command(
      {
        name: 'lead.act',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${String(context.updateId)}`,
      },
      async (scope): Promise<LeadOutcome> => {
        const lead = await scope.repositories.leads.getById(id.data);
        if (lead === undefined) return { outcome: 'not_found' };
        if (lead.version !== version) return { outcome: 'closed' };
        return apply(scope, lead, entry.step, actor, deps.now());
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'closed' };
  }
  const lead = await database.repositories.leads.getById(id.data);
  if (result.outcome === 'not_found' || lead === undefined) {
    await context.edit('Заявка не найдена.');
    return;
  }
  if (result.outcome === 'closed') {
    await show(lead, STALE_TEXT, leadKeyboard(lead));
    return;
  }
  context.logger.info('lead changed by the owner', { status: lead.status });
  await show(lead, result.text, leadKeyboard(lead));
  await context.answer('Записано');
}

interface PendingForget {
  readonly email: string;
  readonly expiresAtMs: number;
}

export interface ForgetFlow {
  readonly forget: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

export const FORGET_USAGE =
  '🗑 Удалить почту человека по его просьбе: /forget anna@example.com — из всех тестов, ' +
  'с подтверждением. Заявки останутся в цифрах без почты.';

/**
 * /forget <email>: a person's deletion request (GDPR, UK GDPR). The email waits in memory for
 * 10 minutes until the owner confirms; the deletion is one idempotent owner command.
 */
export function createForgetFlow(deps: LeadFlowDeps): ForgetFlow {
  const pending = new Map<string, PendingForget>();
  const nowMs = (): number => timestampMs(deps.now());

  return {
    async forget(context) {
      const email = normalizeEmail(context.args);
      if (email === undefined) {
        await context.reply(FORGET_USAGE);
        return;
      }
      const actor = deps.owner(context.userId);
      const leads = await deps.database.leadContacts.leadsByEmail(email, actor);
      if (leads.length === 0) {
        await context.reply('Такой почты нет — удалять нечего.');
        return;
      }
      const current = nowMs();
      for (const [nonce, item] of pending) {
        if (item.expiresAtMs <= current) pending.delete(nonce);
      }
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const nonce = randomBytes(8).toString('hex');
      pending.set(nonce, { email, expiresAtMs: current + CONFIRMATION_TTL_MS });
      await context.reply(
        `❓ Удалить ${email} из заявок: ${String(leads.length)}? Вернуть будет нельзя. ` +
          'Подтверждение действует 10 минут.',
        [
          [
            callbackButton('🗑 Да, удалить', `${FORGET_PREFIX}:y:${nonce}`),
            callbackButton('Отмена', `${FORGET_PREFIX}:n:${nonce}`),
          ],
        ],
      );
    },

    async handleButton(context) {
      const [answer, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (answer === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не удалено.');
        return;
      }
      if (answer !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /forget.');
        return;
      }
      const actor = deps.owner(context.userId);
      const { result } = await deps.database.command(
        {
          name: 'lead.forget',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async (scope) => ({
          erased: await forgetEmail(scope, confirmation.email, actor, deps.now()),
        }),
      );
      if (nonce !== undefined) pending.delete(nonce);
      context.logger.info('lead contacts erased on request', { erased: result.erased });
      await context.edit(`🗑 Удалено: почта из заявок — ${String(result.erased)}.`);
      await context.answer('Удалено');
    },
  };
}

/** The notice of a new lead (no email: it is shown in /leads). */
export function newLeadText(lead: Lead, context: Omit<LeadContext, 'email'>): string {
  const test = context.number === undefined ? 'тест' : `тест №${String(context.number)}`;
  return (
    `📥 Новая заявка: ${test} «${shorten(context.title, 100)}» · ${shorten(lead.channel, 60)}. ` +
    'Почта и действия — /leads'
  );
}
