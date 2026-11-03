import type { CalendarEvent, Database, MetricPoint } from '@roi-dealer/database';
import { addDays, interestTrend, PULSE_WINDOW_DAYS, type InterestTrend } from '@roi-dealer/domain';

/*
 * /pulse and the digest line (05c, ADR-0012): the holidays of the markets for the next six weeks
 * and whether interest in the owner's topics rises. Numbers come from the journals and are
 * computed in code (§2.13); every line names its source.
 */

const MAX_EVENTS = 25;
const MAX_TOPICS = 20;
/** The trend needs the last 7 days and 28 before them. */
const HISTORY_DAYS = 35;

const DIRECTION_LABELS: Readonly<Record<InterestTrend['direction'], string>> = {
  rising: '📈 растёт',
  falling: '📉 падает',
  flat: '➖ ровно',
  insufficient: '… мало данных',
};

function todayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** `2026-11-26` → `26.11`. */
function shortDate(day: string): string {
  const [, month, date] = day.split('-');
  return `${date ?? ''}.${month ?? ''}`;
}

function eventLine(event: CalendarEvent): string {
  const days = event.endsOn === undefined ? '' : `–${shortDate(event.endsOn)}`;
  return `• ${shortDate(event.startsOn)}${days} · ${event.market} · ${event.title}`;
}

interface TopicTrend {
  readonly topic: string;
  readonly trend: InterestTrend;
}

function topicTrends(points: readonly MetricPoint[], today: string): TopicTrend[] {
  const bySeries = new Map<string, MetricPoint[]>();
  for (const point of points) {
    const list = bySeries.get(point.series) ?? [];
    list.push(point);
    bySeries.set(point.series, list);
  }
  // The last complete day is yesterday: the trend ends there.
  const end = addDays(today, -1);
  const order: Readonly<Record<InterestTrend['direction'], number>> = {
    rising: 0,
    falling: 1,
    flat: 2,
    insufficient: 3,
  };
  return [...bySeries.entries()]
    .map(([series, list]) => ({
      topic: series.replace(/^en:/, '').replaceAll('_', ' '),
      trend: interestTrend(list, end),
    }))
    .sort(
      (a, b) =>
        order[a.trend.direction] - order[b.trend.direction] ||
        (b.trend.ratio ?? 0) - (a.trend.ratio ?? 0) ||
        a.topic.localeCompare(b.topic),
    );
}

function topicLine({ topic, trend }: TopicTrend): string {
  if (trend.ratio === undefined || trend.recentAverage === undefined) {
    return `• ${topic} — ${DIRECTION_LABELS[trend.direction]}`;
  }
  const perDay = Math.round(trend.recentAverage).toLocaleString('ru-RU');
  return `• ${topic} — ${DIRECTION_LABELS[trend.direction]} ×${trend.ratio.toFixed(2)} (${perDay} в день)`;
}

async function load(
  database: Pick<Database, 'pulse'>,
  nowMs: number,
): Promise<{ events: CalendarEvent[]; topics: TopicTrend[]; today: string }> {
  const today = todayOf(nowMs);
  const [events, points] = await Promise.all([
    database.pulse.events({ from: today, to: addDays(today, PULSE_WINDOW_DAYS) }),
    database.pulse.points({
      from: addDays(today, -HISTORY_DAYS),
      to: today,
      catalogKey: 'wikimedia-pageviews',
    }),
  ]);
  return { events, topics: topicTrends(points, today), today };
}

/** /pulse: the next six weeks per market and the trend of each followed topic. */
export async function pulseText(database: Pick<Database, 'pulse'>, nowMs: number): Promise<string> {
  const { events, topics, today } = await load(database, nowMs);
  const lines = [
    `🔜 Пульс на ${String(PULSE_WINDOW_DAYS / 7)} недель (до ${shortDate(addDays(today, PULSE_WINDOW_DAYS))}): US, GB, CA, AU`,
    '',
    '📅 Праздники и события',
  ];
  if (events.length === 0) {
    lines.push('Пока пусто: источники праздников ждут доступа в /decisions.');
  } else {
    lines.push(...events.slice(0, MAX_EVENTS).map(eventLine));
    if (events.length > MAX_EVENTS) lines.push(`…и ещё ${String(events.length - MAX_EVENTS)}`);
  }
  lines.push('', '📊 Интерес к темам (Википедия: 7 дней против 4 недель до них)');
  if (topics.length === 0) {
    lines.push(
      'Темы не заданы: PULSE_WIKIPEDIA_ARTICLES и PUBLIC_CONTACT_EMAIL у worker — deploy/hetzner.md, «Заменить ключ».',
    );
  } else {
    lines.push(...topics.slice(0, MAX_TOPICS).map(topicLine));
    if (topics.length > MAX_TOPICS) lines.push(`…и ещё ${String(topics.length - MAX_TOPICS)}`);
  }
  lines.push(
    '',
    'Источники: gov.uk (OGL v3.0), OPM (общественное достояние), Wikimedia (CC0) — /sources',
  );
  return lines.join('\n');
}

/** The digest line: the next holiday within a week and the topics that rise; none when quiet. */
export async function pulseDigestLine(
  database: Pick<Database, 'pulse'>,
  nowMs: number,
): Promise<string | undefined> {
  const { events, topics, today } = await load(database, nowMs);
  const week = addDays(today, 7);
  const soon = events.filter((event) => event.startsOn <= week);
  const rising = topics.filter((topic) => topic.trend.direction === 'rising');
  if (soon.length === 0 && rising.length === 0) return undefined;
  const parts: string[] = [];
  const next = soon[0];
  if (next !== undefined) parts.push(`${shortDate(next.startsOn)} ${next.title} (${next.market})`);
  if (rising.length > 0) {
    parts.push(
      `растут: ${rising
        .slice(0, 3)
        .map((topic) => topic.topic)
        .join(', ')}`,
    );
  }
  return `🔜 Пульс: ${parts.join(' · ')} → /pulse`;
}
