import {
  formatUsd,
  moneySchema,
  timestampMs,
  type Actor,
  type ApprovalKind,
  type EntityType,
  type Money,
  type Timestamp,
} from '@roi-dealer/domain';
import type { StoredEvent } from '@roi-dealer/events';
import { formatKyivDateTime } from './kyiv-time.js';

/*
 * Owner-facing texts of the command center (Russian, plain text: messages are sent without a
 * parse mode, so entity titles written by agents cannot inject markup).
 */

export const NO_DATABASE_TEXT =
  '⚪ База данных не подключена: решения, стоп-кран, журнал и дайджест недоступны.\n' +
  'Подключение — docs/deploy/database.md.';

export const ENTITY_LABELS: Readonly<Record<EntityType, string>> = {
  source: 'Источник',
  evidence: 'Доказательство',
  signal: 'Сигнал',
  pain: 'Боль',
  opportunity: 'Возможность',
  decision: 'Решение',
  approval_request: 'Запрос одобрения',
  hypothesis: 'Гипотеза',
  experiment: 'Эксперимент',
  cost_entry: 'Расход',
  contribution: 'Вклад',
  reward: 'Вознаграждение',
  knowledge_asset: 'Знание',
  system_control: 'Стоп-кран',
};

export const APPROVAL_KIND_LABELS: Readonly<Record<ApprovalKind, string>> = {
  spend: 'Трата',
  recurring_payment: 'Регулярный платёж',
  payout: 'Выплата',
  asset_purchase: 'Покупка актива',
  experiment_launch: 'Запуск эксперимента',
  opportunity_decision: 'Решение по возможности',
  production_change: 'Изменение в продакшене',
  legal: 'Юридический вопрос',
  secret_access: 'Доступ к секрету',
  policy_change: 'Изменение политики',
  budget_change: 'Изменение бюджета',
};

/** One line, at most `max` characters. */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function actorLabel(actor: Actor): string {
  const id = shorten(actor.id, 40);
  switch (actor.type) {
    case 'owner':
      return 'Владелец';
    case 'system':
      return 'Система';
    case 'agent':
      return `Агент ${id}`;
    case 'member':
      return `Участник ${id}`;
    case 'integration':
      return `Интеграция ${id}`;
  }
}

/** `25.09 14:05` for a stored timestamp. */
export function formatTime(timestamp: Timestamp): string {
  return formatKyivDateTime(timestampMs(timestamp));
}

const NAME_FIELDS = ['title', 'name', 'statement', 'description', 'excerpt', 'summary'] as const;

function stringField(snapshot: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = snapshot[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function moneyField(snapshot: Readonly<Record<string, unknown>>, key: string): Money | undefined {
  const parsed = moneySchema.safeParse(snapshot[key]);
  return parsed.success ? parsed.data : undefined;
}

/** What the entity is: `«Buy a domain» · $35.00`, `approve`, `$12.00 «OpenAI API»`. */
function subjectOf(type: EntityType, snapshot: Readonly<Record<string, unknown>>): string {
  const amount = moneyField(snapshot, 'amount');
  const money = amount === undefined ? '' : formatUsd(amount);
  if (type === 'decision') return stringField(snapshot, 'outcome') ?? '';
  if (type === 'system_control') return '';
  const nameKey = NAME_FIELDS.find((key) => stringField(snapshot, key) !== undefined);
  const name = nameKey === undefined ? '' : `«${shorten(String(snapshot[nameKey]), 60)}»`;
  if (type === 'cost_entry') {
    const reversal = stringField(snapshot, 'reversalOf') === undefined ? '' : 'сторно ';
    return [`${reversal}${money}`, name].filter((part) => part !== '').join(' ');
  }
  return [name, money].filter((part) => part !== '').join(' · ');
}

/** `Возможность «…»: draft → under_review`, `➕ Расход $12.00 «OpenAI API»`. */
export function describeEvent(event: StoredEvent): string {
  const { snapshot, previousStatus } = event.payload;
  const label = ENTITY_LABELS[event.aggregate.type];
  const subject = subjectOf(event.aggregate.type, snapshot);
  const status = stringField(snapshot, 'status');
  const title = subject === '' ? label : `${label} ${subject}`;

  if (event.aggregateVersion === 1) {
    return `➕ ${title}${status === undefined ? '' : ` · ${status}`}`;
  }
  const change =
    previousStatus === undefined || previousStatus === status
      ? `изменение (${status ?? 'v' + String(event.aggregateVersion)})`
      : `${previousStatus} → ${status ?? '?'}`;
  const reason = stringField(snapshot, 'reason');
  return `${title}: ${change}${reason === undefined ? '' : ` («${shorten(reason, 80)}»)`}`;
}

const MAX_EVENT_LINE = 130;

/** `25.09 14:05 · Владелец · Возможность «…»: draft → under_review` */
export function eventLine(event: StoredEvent): string {
  return shorten(
    `${formatTime(event.occurredAt)} · ${actorLabel(event.actor)} · ${describeEvent(event)}`,
    MAX_EVENT_LINE,
  );
}
