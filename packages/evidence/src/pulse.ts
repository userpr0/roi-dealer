import { z } from 'zod';
import { DomainError, addDays, PULSE_WINDOW_DAYS } from '@roi-dealer/domain';
import type { CalendarEvent, MetricPoint } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { connectableEntry, findCatalogEntry, integrationActor, SOURCE_CATALOG } from './catalog.js';
import { assertRunning, ensureConnection, type EngineDeps, type EnsureAccess } from './collect.js';
import { EvidenceEngineError } from './errors.js';

/*
 * The "Pulse" engine (05c, ADR-0012): demand series and calendar events from catalog sources,
 * through the same gates as Evidence — kill switch, a catalog entry with verdict `allowed`, an
 * active integration principal the owner granted in /decisions. Only aggregates are stored.
 */

export interface PulseLoad {
  /** The main request, without credentials (logged). */
  readonly requestUrl: string;
  readonly points?: readonly MetricPoint[];
  readonly events?: readonly CalendarEvent[];
}

export interface PulseRequest {
  /** Today in UTC, `YYYY-MM-DD`. */
  readonly today: string;
  readonly signal?: AbortSignal | undefined;
}

/** Reads one catalog source of the Pulse through its official access (§2.21). */
export interface PulseCollector {
  readonly catalogKey: string;
  fetch(request: PulseRequest): Promise<PulseLoad>;
}

export type PulseOutcome =
  | { readonly status: 'collected'; readonly points: number; readonly events: number }
  | {
      readonly status: 'skipped';
      readonly reason:
        'source_missing' | 'source_inactive' | 'access_missing' | 'access_not_active';
    };

function todayOf(deps: EngineDeps): string {
  return new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
}

/**
 * One load of a Pulse source: kill switch → catalog → source → access → fetch → points and
 * events of this source only, stored in one transaction. Nothing is requested from the source
 * unless the owner has granted the integration.
 */
export async function collectPulse(
  collector: PulseCollector,
  deps: EngineDeps & { readonly signal?: AbortSignal | undefined },
): Promise<PulseOutcome> {
  const { database, logger } = deps;
  await assertRunning(database);
  const entry = connectableEntry(collector.catalogKey, deps.catalog ?? SOURCE_CATALOG);
  const source = await database.repositories.sources.getByCatalogKey(entry.key);
  if (source === undefined) return { status: 'skipped', reason: 'source_missing' };
  if (source.status !== 'active') return { status: 'skipped', reason: 'source_inactive' };
  const principal = await database.repositories.principals.getByActor(integrationActor(entry));
  if (principal === undefined) return { status: 'skipped', reason: 'access_missing' };
  if (principal.status !== 'active') return { status: 'skipped', reason: 'access_not_active' };

  const load = await collector.fetch({ today: todayOf(deps), signal: deps.signal });
  const foreign = [...(load.points ?? []), ...(load.events ?? [])].some(
    (item) => item.catalogKey !== entry.key,
  );
  if (foreign) {
    throw new EvidenceEngineError('bad_response', 'A collector returned data of another source', {
      catalog_key: entry.key,
    });
  }
  const points = (load.points ?? []).slice(0, entry.limits.maxItemsPerRun * 40);
  const events = (load.events ?? []).slice(0, entry.limits.maxItemsPerRun);
  const stored = await database.transaction(
    async (scope) => ({
      points: await scope.pulse.recordPoints(points),
      events: await scope.pulse.recordEvents(events),
    }),
    { correlationId: `pulse-collect-${entry.key}-${todayOf(deps)}` },
  );
  logger.info('pulse collected', { catalog_key: entry.key, ...stored });
  return { status: 'collected', ...stored };
}

// ---------------------------------------------------------------- Scheduler

export interface PulseSchedulerOptions extends EngineDeps {
  readonly collectors: readonly PulseCollector[];
  readonly ensureAccess: EnsureAccess;
  /** How often it wakes up; each source still loads at most once per its catalog interval. */
  readonly intervalMs: number;
}

export interface PulseScheduler {
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

/** Like the evidence scheduler: sets up each source's access, then loads it on its interval. */
export function createPulseScheduler(options: PulseSchedulerOptions): PulseScheduler {
  const { logger } = options;
  const now = options.now ?? Date.now;
  const lastRun = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let stopping = false;
  let abort = new AbortController();

  async function runCollector(collector: PulseCollector): Promise<void> {
    const entry = findCatalogEntry(collector.catalogKey, options.catalog ?? SOURCE_CATALOG);
    const minIntervalMs = (entry?.limits.minIntervalMinutes ?? 0) * 60_000;
    const previous = lastRun.get(collector.catalogKey);
    if (previous !== undefined && now() - previous < minIntervalMs) return;
    const log: Logger = logger.child({ catalog_key: collector.catalogKey });
    try {
      const connection = await ensureConnection(collector.catalogKey, options);
      const outcome = await collectPulse(collector, { ...options, signal: abort.signal });
      if (outcome.status === 'collected') lastRun.set(collector.catalogKey, now());
      else
        log.info('pulse collection skipped', { reason: outcome.reason, access: connection.access });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'automation_paused') {
        log.info('pulse collection paused by the kill switch');
        return;
      }
      lastRun.set(collector.catalogKey, now());
      log.error('pulse collection failed', {
        code:
          error instanceof EvidenceEngineError || error instanceof DomainError
            ? error.code
            : 'unknown',
        ...(error instanceof EvidenceEngineError ? { details: error.details } : {}),
      });
    }
  }

  async function runOnce(): Promise<void> {
    for (const collector of options.collectors) {
      if (stopping) return;
      await runCollector(collector);
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = runOnce().finally(() => {
        running = undefined;
        schedule(options.intervalMs);
      });
    }, delayMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      stopping = false;
      abort = new AbortController();
      schedule(0);
      logger.info('pulse collection scheduled', {
        interval_ms: options.intervalMs,
        sources: options.collectors.map((collector) => collector.catalogKey),
      });
    },
    runOnce,
    async stop() {
      stopped = true;
      stopping = true;
      clearTimeout(timer);
      abort.abort();
      await running;
    },
  };
}

// ---------------------------------------------------------------- Shared fetch

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

async function getJson(
  url: string,
  catalogKey: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...options.headers },
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    });
  } catch (error) {
    throw new EvidenceEngineError('fetch_failed', 'The source is not reachable', {
      catalog_key: catalogKey,
      cause: error instanceof Error ? error.name : 'unknown',
    });
  }
  if (!response.ok) {
    throw new EvidenceEngineError('fetch_failed', 'The source answered with an error', {
      catalog_key: catalogKey,
      status: response.status,
    });
  }
  try {
    const json: unknown = await response.json();
    return json;
  } catch {
    throw new EvidenceEngineError('bad_response', 'The source answered with invalid JSON', {
      catalog_key: catalogKey,
    });
  }
}

/** Events within the Pulse's year ahead: what is past is not stored again. */
function upcoming(day: string, today: string): boolean {
  return day >= today && day <= addDays(today, 366);
}

// ---------------------------------------------------------------- UK bank holidays (gov.uk)

export const UK_BANK_HOLIDAYS_CATALOG_KEY = 'uk-bank-holidays';
export const GOV_UK_URL = 'https://www.gov.uk';
const UK_SOURCE_PAGE = 'https://www.gov.uk/bank-holidays';
const UK_DIVISIONS = {
  'england-and-wales': '',
  scotland: ' (Scotland)',
  'northern-ireland': ' (Northern Ireland)',
} as const;

const ukBankHolidaysSchema = z.record(
  z.string(),
  z.object({
    events: z
      .array(z.object({ title: z.string().trim().min(1).max(150), date: z.iso.date() }))
      .max(500),
  }),
);

/**
 * gov.uk `bank-holidays.json` (Open Government Licence v3.0): bank holidays of England and
 * Wales, plus those only Scotland or Northern Ireland have, marked with the region.
 */
export function createUkBankHolidaysCollector(
  options: { readonly baseUrl?: string; readonly requestTimeoutMs?: number } = {},
): PulseCollector {
  const url = `${(options.baseUrl ?? GOV_UK_URL).replace(/\/+$/, '')}/bank-holidays.json`;
  return {
    catalogKey: UK_BANK_HOLIDAYS_CATALOG_KEY,
    async fetch(request) {
      const json = await getJson(url, UK_BANK_HOLIDAYS_CATALOG_KEY, {
        timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        signal: request.signal,
      });
      const parsed = ukBankHolidaysSchema.safeParse(json);
      if (!parsed.success) {
        throw new EvidenceEngineError('bad_response', 'Unexpected bank holidays from gov.uk', {
          catalog_key: UK_BANK_HOLIDAYS_CATALOG_KEY,
        });
      }
      const nationwide = new Set(
        (parsed.data['england-and-wales']?.events ?? []).map(
          (event) => `${event.date}|${event.title}`,
        ),
      );
      const events: CalendarEvent[] = [];
      for (const [division, suffix] of Object.entries(UK_DIVISIONS)) {
        for (const event of parsed.data[division]?.events ?? []) {
          if (!upcoming(event.date, request.today)) continue;
          if (suffix !== '' && nationwide.has(`${event.date}|${event.title}`)) continue;
          events.push({
            catalogKey: UK_BANK_HOLIDAYS_CATALOG_KEY,
            market: 'GB',
            startsOn: event.date,
            title: `${event.title}${suffix}`,
            kind: 'holiday',
            sourceUrl: UK_SOURCE_PAGE,
          });
        }
      }
      return { requestUrl: url, events };
    },
  };
}

// ---------------------------------------------------------------- US federal holidays (OPM)

export const US_FEDERAL_HOLIDAYS_CATALOG_KEY = 'us-federal-holidays';
const OPM_PAGE = 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/';

/**
 * OPM's federal holiday schedules (a US government work, 17 U.S.C. §105), as published on the
 * OPM page: the dates observed for pay and leave. OPM has no API, so the dates live here and are
 * updated from the page once a year (catalog access `manual`).
 */
export const US_FEDERAL_HOLIDAYS: readonly { readonly date: string; readonly title: string }[] = [
  { date: '2026-01-01', title: 'New Year’s Day' },
  { date: '2026-01-19', title: 'Birthday of Martin Luther King, Jr.' },
  { date: '2026-02-16', title: 'Washington’s Birthday' },
  { date: '2026-05-25', title: 'Memorial Day' },
  { date: '2026-06-19', title: 'Juneteenth National Independence Day' },
  { date: '2026-07-03', title: 'Independence Day' },
  { date: '2026-09-07', title: 'Labor Day' },
  { date: '2026-10-12', title: 'Columbus Day' },
  { date: '2026-11-11', title: 'Veterans Day' },
  { date: '2026-11-26', title: 'Thanksgiving Day' },
  { date: '2026-12-25', title: 'Christmas Day' },
  { date: '2027-01-01', title: 'New Year’s Day' },
  { date: '2027-01-18', title: 'Birthday of Martin Luther King, Jr.' },
  { date: '2027-02-15', title: 'Washington’s Birthday' },
  { date: '2027-05-31', title: 'Memorial Day' },
  { date: '2027-06-18', title: 'Juneteenth National Independence Day' },
  { date: '2027-07-05', title: 'Independence Day' },
  { date: '2027-09-06', title: 'Labor Day' },
  { date: '2027-10-11', title: 'Columbus Day' },
  { date: '2027-11-11', title: 'Veterans Day' },
  { date: '2027-11-25', title: 'Thanksgiving Day' },
  { date: '2027-12-24', title: 'Christmas Day' },
];

/** The OPM schedules above as calendar events; nothing is requested over the network. */
export function createUsFederalHolidaysCollector(): PulseCollector {
  return {
    catalogKey: US_FEDERAL_HOLIDAYS_CATALOG_KEY,
    fetch(request) {
      return Promise.resolve({
        requestUrl: OPM_PAGE,
        events: US_FEDERAL_HOLIDAYS.filter((holiday) => upcoming(holiday.date, request.today)).map(
          (holiday) => ({
            catalogKey: US_FEDERAL_HOLIDAYS_CATALOG_KEY,
            market: 'US',
            startsOn: holiday.date,
            title: holiday.title,
            kind: 'holiday' as const,
            sourceUrl: OPM_PAGE,
          }),
        ),
      });
    },
  };
}

// ---------------------------------------------------------------- Wikipedia pageviews

export const WIKIPEDIA_PAGEVIEWS_CATALOG_KEY = 'wikimedia-pageviews';
export const WIKIMEDIA_API_URL = 'https://wikimedia.org/api/rest_v1';
/** Days of history loaded each time: enough for the trend's 7 + 28 days. */
const PAGEVIEW_HISTORY_DAYS = 40;

/** A Wikipedia article title as the owner writes it; spaces become underscores. */
export const wikipediaArticleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((title) => title.replace(/\s+/g, '_'))
  .pipe(z.string().regex(/^[^#<>[\]{}|]+$/));

const pageviewsSchema = z.object({
  items: z
    .array(z.object({ timestamp: z.string().regex(/^\d{10}$/), views: z.int().nonnegative() }))
    .max(400),
});

export interface WikipediaPageviewsOptions {
  /** English Wikipedia articles of the topics to watch, e.g. `Tax_return`. */
  readonly articles: readonly string[];
  /** Wikimedia requires a User-Agent with the tool's name and a contact (catalog condition). */
  readonly userAgent: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
}

/**
 * Daily views of a few English Wikipedia articles (Analytics API, CC0), one request after
 * another as the access policy asks. Series `en:<Article>`; English Wikipedia serves all
 * markets of D-008 together, so the series has no market.
 */
export function createWikipediaPageviewsCollector(
  options: WikipediaPageviewsOptions,
): PulseCollector {
  const baseUrl = (options.baseUrl ?? WIKIMEDIA_API_URL).replace(/\/+$/, '');
  const articles = options.articles.map((article) => wikipediaArticleSchema.parse(article));
  const stamp = (day: string): string => `${day.replaceAll('-', '')}00`;
  const urlOf = (article: string, from: string, to: string): string =>
    `${baseUrl}/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article)}/daily/${stamp(from)}/${stamp(to)}`;

  return {
    catalogKey: WIKIPEDIA_PAGEVIEWS_CATALOG_KEY,
    async fetch(request) {
      // Yesterday is the last complete day.
      const to = addDays(request.today, -1);
      const from = addDays(to, -PAGEVIEW_HISTORY_DAYS + 1);
      const points: MetricPoint[] = [];
      for (const article of articles) {
        let json: unknown;
        try {
          json = await getJson(urlOf(article, from, to), WIKIPEDIA_PAGEVIEWS_CATALOG_KEY, {
            headers: { 'user-agent': options.userAgent },
            timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
            signal: request.signal,
          });
        } catch (error) {
          // 404: no such article, or no views in the period — nothing to store for it.
          if (error instanceof EvidenceEngineError && error.details['status'] === 404) continue;
          throw error;
        }
        const parsed = pageviewsSchema.safeParse(json);
        if (!parsed.success) {
          throw new EvidenceEngineError('bad_response', 'Unexpected pageviews from Wikimedia', {
            catalog_key: WIKIPEDIA_PAGEVIEWS_CATALOG_KEY,
          });
        }
        for (const item of parsed.data.items) {
          const t = item.timestamp;
          points.push({
            catalogKey: WIKIPEDIA_PAGEVIEWS_CATALOG_KEY,
            series: `en:${article}`,
            day: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`,
            value: item.views,
          });
        }
      }
      return {
        requestUrl: articles.length > 0 ? urlOf(articles[0] ?? '', from, to) : baseUrl,
        points,
      };
    },
  };
}

/** The window the Pulse shows, from today. */
export function pulseWindow(today: string): { readonly from: string; readonly to: string } {
  return { from: today, to: addDays(today, PULSE_WINDOW_DAYS) };
}
