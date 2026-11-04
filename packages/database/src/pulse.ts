import { z } from 'zod';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';

/*
 * The "Pulse" journals (05c, ADR-0012, migration 0021): daily values of demand series and the
 * calendar of holidays, seasons and regulatory dates. Aggregates from catalog sources only: no
 * people, no events. A repeated load updates the stored value instead of adding rows.
 */

export const CALENDAR_EVENT_KINDS = ['holiday', 'season', 'regulatory'] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

const catalogKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const marketSchema = z.string().regex(/^[A-Z]{2}$/);
/** A calendar day, `YYYY-MM-DD`. */
export const daySchema = z.iso.date();

export const metricPointSchema = z.strictObject({
  catalogKey: catalogKeySchema,
  series: z.string().trim().min(1).max(200),
  market: marketSchema.optional(),
  day: daySchema,
  value: z.number().finite().nonnegative(),
});
export type MetricPoint = z.infer<typeof metricPointSchema>;

export const calendarEventSchema = z
  .strictObject({
    catalogKey: catalogKeySchema,
    market: marketSchema,
    startsOn: daySchema,
    endsOn: daySchema.optional(),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(CALENDAR_EVENT_KINDS),
    sourceUrl: z.url({ protocol: /^https?$/ }).max(500),
  })
  .refine((event) => event.endsOn === undefined || event.endsOn >= event.startsOn, {
    error: 'the event ends before it starts',
  });
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export interface PulseJournal {
  /** Stores the points; a point of the same source, series and day replaces the old value. */
  recordPoints(points: readonly MetricPoint[]): Promise<number>;
  /** Stores the events; an event of the same source, market, start and title is updated. */
  recordEvents(events: readonly CalendarEvent[]): Promise<number>;
  /** Points with `from <= day <= to`, by series and day. */
  points(filter: {
    readonly from: string;
    readonly to: string;
    readonly catalogKey?: string | undefined;
  }): Promise<MetricPoint[]>;
  /** Events that start or last within `from..to`, by start and market. */
  events(filter: { readonly from: string; readonly to: string }): Promise<CalendarEvent[]>;
}

/** Postgres returns `date` as a Date at midnight UTC (sessions run in UTC). */
function dayOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function readPoint(row: Row): MetricPoint {
  const market = row['market'];
  return {
    catalogKey: String(row['catalog_key']),
    series: String(row['series']),
    ...(typeof market === 'string' ? { market } : {}),
    day: dayOf(row['day']),
    value: Number(row['value']),
  };
}

function readEvent(row: Row): CalendarEvent {
  const endsOn = row['ends_on'];
  return {
    catalogKey: String(row['catalog_key']),
    market: String(row['market']),
    startsOn: dayOf(row['starts_on']),
    ...(endsOn === null || endsOn === undefined ? {} : { endsOn: dayOf(endsOn) }),
    title: String(row['title']),
    kind: row['kind'] as CalendarEventKind,
    sourceUrl: String(row['source_url']),
  };
}

export function createPulseJournal(executor: Executor): PulseJournal {
  return {
    recordPoints: (points) =>
      translated(async () => {
        let stored = 0;
        for (const input of points) {
          const point = metricPointSchema.parse(input);
          await executor`
            insert into metric_points (catalog_key, series, market, day, value)
            values (${point.catalogKey}, ${point.series}, ${point.market ?? null},
                    ${point.day}::date, ${point.value})
            on conflict (catalog_key, series, day) do update set
              market = excluded.market, value = excluded.value, collected_at = now()
          `;
          stored += 1;
        }
        return stored;
      }),

    recordEvents: (events) =>
      translated(async () => {
        let stored = 0;
        for (const input of events) {
          const event = calendarEventSchema.parse(input);
          await executor`
            insert into calendar_events
              (catalog_key, market, starts_on, ends_on, title, kind, source_url)
            values (${event.catalogKey}, ${event.market}, ${event.startsOn}::date,
                    ${event.endsOn ?? null}::date, ${event.title}, ${event.kind},
                    ${event.sourceUrl})
            on conflict (catalog_key, market, starts_on, title) do update set
              ends_on = excluded.ends_on, kind = excluded.kind,
              source_url = excluded.source_url, collected_at = now()
          `;
          stored += 1;
        }
        return stored;
      }),

    points: (filter) =>
      translated(async () => {
        const from = daySchema.parse(filter.from);
        const to = daySchema.parse(filter.to);
        const key =
          filter.catalogKey === undefined ? null : catalogKeySchema.parse(filter.catalogKey);
        const rows = await executor<Row[]>`
          select * from metric_points
          where day between ${from}::date and ${to}::date
            and (${key}::text is null or catalog_key = ${key})
          order by catalog_key, series, day
          limit 20000
        `;
        return rows.map(readPoint);
      }),

    events: (filter) =>
      translated(async () => {
        const from = daySchema.parse(filter.from);
        const to = daySchema.parse(filter.to);
        const rows = await executor<Row[]>`
          select * from calendar_events
          where starts_on <= ${to}::date and coalesce(ends_on, starts_on) >= ${from}::date
          order by starts_on, market, title
          limit 500
        `;
        return rows.map(readEvent);
      }),
  };
}
