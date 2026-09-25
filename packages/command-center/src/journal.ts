import { toTimestamp } from '@roi-dealer/domain';
import type { EventStore } from '@roi-dealer/database';
import type { StoredEvent } from '@roi-dealer/events';
import { callbackButton, type InlineKeyboard } from '@roi-dealer/telegram';
import { eventLine } from './texts.js';

const HOUR_MS = 3_600_000;

/** Periods of the 🧾 Journal and 🕘 History buttons (D-010), counted back from now. */
export const PERIODS = {
  day: { button: 'День', title: 'за сутки', ms: 24 * HOUR_MS },
  week: { button: 'Неделя', title: 'за неделю', ms: 7 * 24 * HOUR_MS },
  month: { button: 'Месяц', title: 'за 30 дней', ms: 30 * 24 * HOUR_MS },
} as const;
export type Period = keyof typeof PERIODS;

export function isPeriod(value: string): value is Period {
  return Object.hasOwn(PERIODS, value);
}

/** At most this many lines in one reply. */
export const MAX_LINES = 30;
/** Telegram's limit for one message. */
const MAX_MESSAGE_LENGTH = 4_096;
/** Events read per period at most; a longer period is reported as partial. */
const MAX_SCANNED = 10_000;
const PAGE_SIZE = 1_000;

const EXPERIMENT_MILESTONES = new Set(['running', 'stopped', 'completed', 'cancelled']);

/**
 * 🕘 History: decisions and money only — owner decisions, approvals, experiment launches and
 * results, costs and the kill switch.
 */
export function isHistoryEvent(event: StoredEvent): boolean {
  switch (event.aggregate.type) {
    case 'decision':
    case 'approval_request':
    case 'cost_entry':
    case 'system_control':
      return true;
    case 'experiment': {
      const status = event.payload.snapshot['status'];
      return event.aggregateVersion > 1 && EXPERIMENT_MILESTONES.has(String(status));
    }
    case 'source':
    case 'evidence':
    case 'signal':
    case 'pain':
    case 'opportunity':
    case 'hypothesis':
    case 'contribution':
    case 'reward':
    case 'knowledge_asset':
      return false;
  }
}

export interface CollectedEvents {
  /** Matching events of the period in recording order. */
  readonly events: readonly StoredEvent[];
  /** More than `MAX_SCANNED` events were written in the period; `events` holds the first ones. */
  readonly partial: boolean;
}

/** Every event of `[from, to)` that passes `filter`, in recording order (§2.13: from the store). */
export async function collectEvents(
  store: EventStore,
  period: { readonly fromMs: number; readonly toMs: number },
  filter: (event: StoredEvent) => boolean = () => true,
): Promise<CollectedEvents> {
  const from = toTimestamp(new Date(period.fromMs));
  const to = toTimestamp(new Date(period.toMs));
  const events: StoredEvent[] = [];
  let after: number | undefined;
  let scanned = 0;
  while (scanned < MAX_SCANNED) {
    const page = await store.list({ from, to, after, limit: PAGE_SIZE });
    events.push(...page.filter(filter));
    scanned += page.length;
    if (page.length < PAGE_SIZE) return { events, partial: false };
    after = page.at(-1)?.position;
  }
  return { events, partial: true };
}

export type JournalKind = 'journal' | 'history';

const KINDS = {
  journal: { prefix: 'jr', title: '🧾 Журнал', empty: 'Изменений не было.' },
  history: { prefix: 'hs', title: '🕘 История', empty: 'Решений и расходов не было.' },
} as const;

export function callbackPrefix(kind: JournalKind): string {
  return KINDS[kind].prefix;
}

/** Period buttons; the shown period is marked. */
export function periodKeyboard(kind: JournalKind, active?: Period): InlineKeyboard {
  return [
    (Object.keys(PERIODS) as Period[]).map((period) =>
      callbackButton(
        period === active ? `• ${PERIODS[period].button}` : PERIODS[period].button,
        `${KINDS[kind].prefix}:${period}`,
      ),
    ),
  ];
}

export function choosePeriodText(kind: JournalKind): string {
  return `${KINDS[kind].title}: выберите период.`;
}

/** The latest `MAX_LINES` events of the period, oldest first, in Kyiv time. */
export async function journalText(
  store: EventStore,
  kind: JournalKind,
  period: Period,
  nowMs: number,
): Promise<string> {
  const { events, partial } = await collectEvents(
    store,
    { fromMs: nowMs - PERIODS[period].ms, toMs: nowMs + 1 },
    kind === 'history' ? isHistoryEvent : undefined,
  );
  const header = `${KINDS[kind].title} ${PERIODS[period].title} (время по Киеву)`;
  if (events.length === 0) return `${header}\n\n${KINDS[kind].empty}`;

  const lines = events.slice(-MAX_LINES).map(eventLine);
  const render = (): string => {
    const hidden = events.length - lines.length;
    const notes = [
      hidden > 0 ? `…и ещё ${hidden} раньше. Показаны последние ${lines.length}.` : undefined,
      partial ? `Прочитаны первые ${MAX_SCANNED} событий периода.` : undefined,
    ].filter((note) => note !== undefined);
    return [header, '', ...notes, ...lines].join('\n');
  };
  let text = render();
  while (text.length > MAX_MESSAGE_LENGTH && lines.length > 1) {
    lines.shift();
    text = render();
  }
  return text;
}
