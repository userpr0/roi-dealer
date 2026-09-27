/**
 * Owner time is Kyiv time (D-009): digest at 10:00 `Europe/Kyiv`, journal lines in Kyiv time.
 * Offsets come from the built-in time zone database (`Intl`), so the switches between
 * summer (UTC+3) and winter (UTC+2) time need no code.
 */
export const KYIV_TIME_ZONE = 'Europe/Kyiv';

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const wallTimeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: KYIV_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** What Kyiv clocks show at `ms`. */
function kyivWallTime(ms: number): WallTime {
  const parts = new Map(
    wallTimeFormat.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type));
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
}

/** Kyiv minus UTC at `ms`, in milliseconds. */
function kyivOffsetMs(ms: number): number {
  const wall = kyivWallTime(ms);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallAsUtc - Math.floor(ms / 1_000) * 1_000;
}

/** The instant when Kyiv clocks show the given date and time (`month` is 1–12). */
export function kyivInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the offset is taken at the approximate instant, then at the corrected one.
  const approximate = wallAsUtc - kyivOffsetMs(wallAsUtc);
  return wallAsUtc - kyivOffsetMs(approximate);
}

/** Today's `hour:minute` in Kyiv (may be in the past). */
export function kyivTimeToday(nowMs: number, hour: number, minute = 0): number {
  const today = kyivWallTime(nowMs);
  return kyivInstant(today.year, today.month, today.day, hour, minute);
}

/** The next instant strictly after `nowMs` when Kyiv clocks show `hour:minute`. */
export function nextKyivTime(nowMs: number, hour: number, minute = 0): number {
  const today = kyivWallTime(nowMs);
  const candidate = kyivInstant(today.year, today.month, today.day, hour, minute);
  if (candidate > nowMs) return candidate;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return kyivInstant(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
  );
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `2026-09-25`: the Kyiv calendar day, e.g. for the digest idempotency key. */
export function kyivDate(ms: number): string {
  const wall = kyivWallTime(ms);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** `25.09.2026` */
export function formatKyivDate(ms: number): string {
  const wall = kyivWallTime(ms);
  return `${pad(wall.day)}.${pad(wall.month)}.${wall.year}`;
}

/** `25.09 14:05` */
export function formatKyivDateTime(ms: number): string {
  const wall = kyivWallTime(ms);
  return `${pad(wall.day)}.${pad(wall.month)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}
