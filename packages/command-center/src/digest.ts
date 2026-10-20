import {
  costEntrySchema,
  experimentDay,
  formatUsd,
  summarizeCosts,
  toTimestamp,
  type CostEntry,
} from '@roi-dealer/domain';
import type { Database, ServiceIncident } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { aiDigestLine } from './ai-status.js';
import { decidableRequests } from './approvals.js';
import { reviewCount } from './opportunity-cards.js';
import { collectEvents, PERIODS } from './journal.js';
import { killSwitchStatus } from './kill-switch.js';
import { rewardsDigestLine } from './rewards.js';
import { formatKyivDate, kyivDate, kyivTimeToday, nextKyivTime } from './kyiv-time.js';
import { formatTime } from './texts.js';

/** D-009: every day at 10:00 Europe/Kyiv. */
export const DIGEST_HOUR = 10;
/** A digest missed at 10:00 (restart, database down) is still sent until 12:00. */
export const DIGEST_WINDOW_MS = 2 * 3_600_000;
/** Retry interval inside the window. */
export const DIGEST_RETRY_MS = 5 * 60_000;

/** The morning summary, from the database only (§2.13). */
export async function buildDigest(
  database: Pick<
    Database,
    'repositories' | 'events' | 'access' | 'aiCalls' | 'agentRuns' | 'services'
  >,
  nowMs: number,
): Promise<string> {
  const now = toTimestamp(new Date(nowMs));
  // Alerts (PHASE 13): failed agent runs and tests past their calendar limit.
  const agentFailures = [
    ...(await database.agentRuns.totals(toTimestamp(new Date(nowMs - PERIODS.day.ms)))).values(),
  ].reduce((sum, totals) => sum + totals.failed, 0);
  const overdue = (
    await database.repositories.experiments.listByStatus('running', { limit: 1_000 })
  ).filter((experiment) => experimentDay(experiment, now)?.overdue === true).length;
  const ai = await aiDigestLine(database.aiCalls, nowMs);
  const rewards = await rewardsDigestLine(database.repositories);
  const refused = await database.access.count({
    from: toTimestamp(new Date(nowMs - PERIODS.day.ms)),
    to: toTimestamp(new Date(nowMs + 1)),
    decision: 'denied',
  });
  // The watchdog's notices of the day (13c): what stopped and whether it is back.
  const incidents = await database.services.incidentsSince(
    toTimestamp(new Date(nowMs - PERIODS.day.ms)),
  );
  const requests = await decidableRequests(database.repositories, now);
  const review = await reviewCount(database.repositories);
  const nearest = requests[0];
  const { events, partial } = await collectEvents(database.events, {
    fromMs: nowMs - PERIODS.day.ms,
    toMs: nowMs + 1,
  });
  const byOwner = events.filter((event) => event.actor.type === 'owner').length;
  const evidence = events.filter((event) => event.type === 'evidence.created').length;
  const signals = events.filter((event) => event.type === 'signal.created').length;
  const newPains = events.filter((event) => event.type === 'pain.created').length;
  const newOpportunities = events.filter((event) => event.type === 'opportunity.created').length;
  const costs = events.flatMap((event): CostEntry[] => {
    if (event.type !== 'cost_entry.created') return [];
    const parsed = costEntrySchema.safeParse(event.payload.snapshot);
    return parsed.success ? [parsed.data] : [];
  });

  return [
    `📰 Дайджест · ${formatKyivDate(nowMs)}`,
    '',
    requests.length === 0
      ? '📥 Решений, которые ждут вас, нет.'
      : `📥 Ждут решения: ${requests.length}` +
        (nearest === undefined ? '' : ` · ближайший срок ${formatTime(nearest.expiresAt)}`) +
        ' → /decisions',
    ...(review === 0 ? [] : [`⚖️ Возможностей на решение: ${String(review)} → /decisions`]),
    `🧾 За сутки изменений: ${events.length}${partial ? '+' : ''}, ваших: ${byOwner} → /journal`,
    costs.length === 0
      ? '💸 Расходов за сутки не записано.'
      : `💸 Расходы за сутки: ${formatUsd(summarizeCosts(costs).total)} · записей: ${costs.length} → /history`,
    ...(evidence === 0
      ? []
      : [`📚 Новых доказательств за сутки: ${evidence}${partial ? '+' : ''} → /journal`]),
    ...(signals === 0
      ? []
      : [
          `🧩 За сутки: сигналов ${String(signals)}${partial ? '+' : ''}, новых болей ${String(newPains)} → /pains`,
        ]),
    ...(newOpportunities === 0
      ? []
      : [
          `💡 Новых возможностей за сутки: ${String(newOpportunities)}${partial ? '+' : ''} → /opportunities`,
        ]),
    ...(ai === undefined ? [] : [ai]),
    ...(agentFailures === 0
      ? []
      : [`⚠️ Сбоев агентов за сутки: ${String(agentFailures)} → /agents`]),
    ...(overdue === 0 ? [] : [`⏰ Просроченных тестов: ${String(overdue)} → /experiments`]),
    ...(rewards === undefined ? [] : [rewards]),
    ...(refused === 0 ? [] : [`🔐 Отклонённых попыток доступа за сутки: ${refused} → /access`]),
    ...(incidents.length === 0
      ? []
      : [
          `🛠 Сторож за сутки: ${String(incidents.length)} (${incidents
            .map(
              (incident) =>
                `${incidentLabel(incident)}${incident.resolvedAt === undefined ? ' — не решено' : ''}`,
            )
            .join('; ')}) → /status`,
        ]),
    await killSwitchStatus(database.repositories, database.events),
  ].join('\n');
}

export interface DigestSchedulerOptions {
  /** Sends the digest of the Kyiv day `date` (`YYYY-MM-DD`) at most once; throws on failure. */
  readonly send: (date: string) => Promise<void>;
  readonly logger: Logger;
  readonly now?: () => number;
}

export interface DigestScheduler {
  start(): void;
  /** Cancels the timer and waits for a digest being sent. */
  stop(): Promise<void>;
}

/**
 * Wakes up at 10:00 Kyiv. Inside the window it sends today's digest, retrying every 5 minutes
 * on failure; after a restart inside the window it catches up. `send` must be idempotent per
 * day (the database command key `digest-<date>`), so a restart never sends it twice.
 */
export function createDigestScheduler(options: DigestSchedulerOptions): DigestScheduler {
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  let sentFor: string | undefined;

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(() => {
        running = undefined;
      });
    }, delayMs);
    timer.unref();
  }

  async function tick(): Promise<void> {
    const current = now();
    const target = kyivTimeToday(current, DIGEST_HOUR);
    const today = kyivDate(current);
    const inWindow = current >= target && current < target + DIGEST_WINDOW_MS;
    let retry = false;
    if (inWindow && sentFor !== today) {
      try {
        await options.send(today);
        sentFor = today;
      } catch (error) {
        retry = current + DIGEST_RETRY_MS < target + DIGEST_WINDOW_MS;
        options.logger.error('daily digest failed', { date: today, retry, error });
      }
    }
    const later = now();
    schedule(retry ? DIGEST_RETRY_MS : nextKyivTime(later, DIGEST_HOUR) - later);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // Immediately: catches up a digest missed during a restart inside the window.
      schedule(0);
      options.logger.info('daily digest scheduled', {
        next_at: new Date(nextKyivTime(now(), DIGEST_HOUR)).toISOString(),
      });
    },

    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/** Sends the digest of `date` once: the command key is `digest-<date>`. */
export async function sendDailyDigest(
  database: Database,
  date: string,
  nowMs: number,
  deliver: (text: string) => Promise<void>,
): Promise<'sent' | 'already_sent'> {
  const key = `digest-${date}`;
  const { outcome } = await database.command(
    { name: 'digest.send', idempotencyKey: key, correlationId: key },
    async (scope) => {
      // Delivered inside the command: a failed delivery stores nothing and can be retried.
      await deliver(
        await buildDigest(
          {
            ...scope,
            access: database.access,
            aiCalls: database.aiCalls,
            agentRuns: database.agentRuns,
          },
          nowMs,
        ),
      );
      return { sentAt: toTimestamp(new Date(nowMs)) };
    },
  );
  return outcome === 'executed' ? 'sent' : 'already_sent';
}

const INCIDENT_LABELS = {
  silent: (subject: string) => `${subject} молчал`,
  version: (subject: string) => `${subject} на другой версии`,
  ai_key: (subject: string) => `ключ ${subject} не принят`,
} as const;

function incidentLabel(incident: Pick<ServiceIncident, 'kind' | 'subject'>): string {
  return INCIDENT_LABELS[incident.kind](incident.subject);
}
