import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@roi-dealer/database';
import {
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  toTimestamp,
  utmSchema,
  type Actor,
  type ExperimentId,
  type HypothesisId,
  type NewPrincipal,
} from '@roi-dealer/domain';
import type { Logger } from '@roi-dealer/observability';

/*
 * The funnel counter of own pages (PHASE 21, ADR-0007 source `tracker`): a view of a released
 * landing is `attention`, a press of its button `cta_click`. It writes as the integration
 * `site`, which the owner grants in /decisions; the kill switch stops it. Nothing about the
 * visitor is stored or logged: the repeat check keeps a salted hash in memory for 30 minutes.
 */

/** The identity the page counter writes as (PHASE 21). */
export const SITE_TRACKER: Actor = { type: 'integration', id: 'site' };

export const SITE_ACCESS: NewPrincipal = {
  actor: SITE_TRACKER,
  displayName: 'Сайт тестов',
  purpose:
    'Считает просмотры и нажатия кнопки на опубликованных страницах тестов — шаги воронки ' +
    '«внимание» и «клики CTA», только пока тест идёт. Не хранит IP, cookies и персональные ' +
    'данные; повтор того же посетителя за 30 минут не считается. Ничего не тратит.',
};

/** Funnel stages the pages count themselves. */
export const TRACKED_STAGES = ['attention', 'cta_click'] as const;
export type TrackedStage = (typeof TRACKED_STAGES)[number];

/** What the request tells the counter; nothing of it is stored. */
export interface SiteVisit {
  readonly method: string;
  /** Query parameters of the address; only `utm_*` are read. */
  readonly query: Readonly<Record<string, string>>;
  readonly userAgent?: string | undefined;
  /** The client address: behind a proxy the first `x-forwarded-for` entry. */
  readonly address?: string | undefined;
  /** `Sec-Purpose` or `Purpose`: prefetch and prerender are not visits. */
  readonly purpose?: string | undefined;
  readonly correlationId?: string | undefined;
}

export interface TrackTarget {
  readonly experimentId: ExperimentId;
  readonly hypothesisId: HypothesisId;
  readonly channel: string;
}

export type TrackOutcome =
  'recorded' | 'not_a_visit' | 'repeat' | 'rate_limited' | 'paused' | 'no_access' | 'failed';

export interface SiteTracker {
  /** Records one stage of a running experiment for this visit when it counts; never throws. */
  track(target: TrackTarget, stage: TrackedStage, visit: SiteVisit): Promise<TrackOutcome>;
}

export interface SiteTrackerOptions {
  readonly database: Pick<Database, 'repositories' | 'funnel'>;
  readonly logger: Logger;
  readonly now?: () => number;
  /** How long a visitor's repeat of the same stage is not counted (default 30 minutes). */
  readonly repeatWindowMs?: number;
  /** Events a process records per minute at most (default 600). */
  readonly maxPerMinute?: number;
  /** How long the kill switch and the access state are cached (default 30 s). */
  readonly stateTtlMs?: number;
}

const REPEAT_WINDOW_MS = 30 * 60_000;
const MAX_PER_MINUTE = 600;
const STATE_TTL_MS = 30_000;
const MAX_VISITORS = 50_000;

/** Robots, link previews and command-line clients: their requests are not visits. */
const ROBOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|curl|wget|python|httpclient|headless|lighthouse/i;
const PREFETCH = /prefetch|prerender|preview/i;

/** The UTM tags of the address that pass the funnel schema; others are dropped. */
export function utmOf(query: Readonly<Record<string, string>>): Record<string, string> {
  const utm: Record<string, string> = {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term'] as const) {
    const value = query[`utm_${key}`];
    if (value === undefined) continue;
    const parsed = utmSchema.shape[key].safeParse(value);
    if (parsed.success && parsed.data !== undefined) utm[key] = parsed.data;
  }
  return utm;
}

/** Whether the request is a person's visit: a GET from a browser, not a robot or a prefetch. */
export function isVisit(visit: SiteVisit): boolean {
  if (visit.method !== 'GET') return false;
  const agent = visit.userAgent?.trim() ?? '';
  if (agent === '' || ROBOT.test(agent)) return false;
  return visit.purpose === undefined || !PREFETCH.test(visit.purpose);
}

export function createSiteTracker(options: SiteTrackerOptions): SiteTracker {
  const { database, logger } = options;
  const now = options.now ?? Date.now;
  const repeatWindowMs = options.repeatWindowMs ?? REPEAT_WINDOW_MS;
  const maxPerMinute = options.maxPerMinute ?? MAX_PER_MINUTE;
  const stateTtlMs = options.stateTtlMs ?? STATE_TTL_MS;
  // A process secret: hashes of visitors cannot be matched outside this process.
  const salt = randomBytes(16);
  const seen = new Map<string, number>();
  let minute = { startMs: 0, count: 0, warned: false };
  let state: { readonly atMs: number; readonly outcome?: 'paused' | 'no_access' } | undefined;

  const visitorKey = (target: TrackTarget, stage: TrackedStage, visit: SiteVisit): string =>
    createHash('sha256')
      .update(salt)
      .update(`${target.experimentId}|${stage}|${visit.address ?? ''}|${visit.userAgent ?? ''}`)
      .digest('base64url');

  const remember = (key: string, atMs: number): void => {
    if (seen.size >= MAX_VISITORS) {
      for (const [item, expiresAtMs] of seen) {
        if (expiresAtMs <= atMs) seen.delete(item);
      }
      while (seen.size >= MAX_VISITORS) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    }
    seen.set(key, atMs + repeatWindowMs);
  };

  /** The kill switch and the counter's access, cached briefly to spare the database. */
  const blocked = async (atMs: number): Promise<'paused' | 'no_access' | undefined> => {
    if (state !== undefined && atMs - state.atMs < stateTtlMs) return state.outcome;
    const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    if (control === undefined) throw new Error('the automation kill switch is missing');
    let outcome: 'paused' | 'no_access' | undefined;
    try {
      assertAutomationRunning(control);
    } catch {
      outcome = 'paused';
    }
    if (outcome === undefined) {
      const principal = await database.repositories.principals.getByActor(SITE_TRACKER);
      if (principal?.status !== 'active') outcome = 'no_access';
    }
    state = outcome === undefined ? { atMs } : { atMs, outcome };
    return outcome;
  };

  return {
    async track(target, stage, visit) {
      try {
        if (!isVisit(visit)) return 'not_a_visit';
        const atMs = now();
        const key = visitorKey(target, stage, visit);
        const until = seen.get(key);
        if (until !== undefined && until > atMs) return 'repeat';
        if (atMs - minute.startMs >= 60_000) minute = { startMs: atMs, count: 0, warned: false };
        if (minute.count >= maxPerMinute) {
          if (!minute.warned) {
            logger.warn('page events over the limit of the minute', { limit: maxPerMinute });
            minute = { ...minute, warned: true };
          }
          return 'rate_limited';
        }
        const stop = await blocked(atMs);
        if (stop !== undefined) return stop;
        minute = { ...minute, count: minute.count + 1 };
        await database.funnel.record(
          [
            {
              experimentId: target.experimentId,
              hypothesisId: target.hypothesisId,
              stage,
              quantity: 1,
              channel: target.channel,
              utm: utmOf(visit.query),
              occurredAt: toTimestamp(new Date(atMs)),
              source: 'tracker',
            },
          ],
          SITE_TRACKER,
          visit.correlationId,
        );
        remember(key, atMs);
        return 'recorded';
      } catch (error) {
        // The page is still served; the error has no visitor data.
        logger.error('page event not recorded', { stage, error });
        return 'failed';
      }
    },
  };
}
