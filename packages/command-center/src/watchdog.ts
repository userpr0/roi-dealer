import { timestampMs, toTimestamp, type Timestamp } from '@roi-dealer/domain';
import type {
  AiProvider,
  Database,
  ServiceHeartbeat,
  ServiceIncident,
  ServiceName,
} from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { decidableRequests } from './approvals.js';
import { formatTime } from './texts.js';

/*
 * The service watchdog (13c, D-023): the bot reads the marks the worker and the api leave once a
 * minute and tells the owner — once per incident — when one falls silent, when the services run
 * different versions (a deploy did not go through), when an AI key is rejected, and when each of
 * these is over. It only reads and notifies: no state of the business changes, so it keeps
 * watching while the kill switch is on — the moment the owner most needs to know.
 */

/** A service that has not marked for this long is silent. */
export const SILENT_AFTER_MS = 10 * 60_000;
/** After the bot's start, services get this long to reach its version before it is reported. */
export const VERSION_GRACE_MS = 20 * 60_000;
/** AI calls looked at for rejected keys. */
const AI_KEY_WINDOW_MS = 60 * 60_000;
const WATCHED: readonly ServiceName[] = ['worker', 'api'];
const DEFAULT_INTERVAL_MS = 60_000;

export const AI_PROVIDER_SETUP: Readonly<
  Record<AiProvider, { readonly name: string; readonly variable: string }>
> = {
  anthropic: { name: 'Anthropic (Claude)', variable: 'ANTHROPIC_API_KEY' },
  openai: { name: 'OpenAI (GPT)', variable: 'OPENAI_API_KEY' },
  google: { name: 'Google (Gemini)', variable: 'GEMINI_API_KEY' },
};

function minutes(fromMs: number, toMs: number): string {
  return `${String(Math.max(1, Math.round((toMs - fromMs) / 60_000)))} мин`;
}

export function silentText(service: ServiceName, lastSeen: Timestamp, nowMs: number): string {
  return [
    `🔴 ${service} молчит ${minutes(timestampMs(lastSeen), nowMs)}: последняя отметка ${formatTime(lastSeen)} (Киев).`,
    `Hetzner → сервер → Power → Reboot перезапустит сервисы, данные сохранятся (deploy/hetzner.md). Когда ${service} заработает, я напишу.`,
  ].join('\n');
}

export function recoveredText(service: ServiceName, lastSeen: Timestamp, nowMs: number): string {
  return `🟢 ${service} снова работает (молчал около ${minutes(timestampMs(lastSeen), nowMs)}).`;
}

export function versionText(service: ServiceName, serviceVersion: string, bot: string): string {
  return [
    `⚠️ Версии разошлись: бот — ${bot}, ${service} — ${serviceVersion}. Последний деплой одного из них не прошёл.`,
    'Сервер обновляется сам раз в 5 минут. Если версии не сойдутся за час — Hetzner → сервер → Power → Reboot.',
  ].join('\n');
}

export function versionFixedText(service: ServiceName, version: string): string {
  return `✅ ${service} на той же версии, что и бот (${version}).`;
}

export function aiKeyText(provider: AiProvider, rejected: number): string {
  const { name, variable } = AI_PROVIDER_SETUP[provider];
  return [
    `🔑 Ключ ${name} не принят: ${String(rejected)} вызовов за час с ошибкой доступа.`,
    `Замените ${variable} — deploy/hetzner.md, «Заменить ключ» — и проверьте баланс в кабинете провайдера. Пока работают другие провайдеры.`,
  ].join('\n');
}

export function aiKeyFixedText(provider: AiProvider): string {
  return `✅ Ключ ${AI_PROVIDER_SETUP[provider].name} снова работает.`;
}

export interface ServiceWatchdogOptions {
  readonly database: Database;
  readonly logger: Logger;
  /** Delivers a notice to the owner; must throw when delivery fails (it is retried). */
  readonly deliver: (text: string) => Promise<void>;
  /** The bot's own version (compared with the services') and the time it started. */
  readonly version: string;
  readonly startedAtMs: number;
  readonly now?: (() => number) | undefined;
  /** Default: one minute. */
  readonly intervalMs?: number | undefined;
  /** With the bot's own setup, the owner is told once when everything is set up. */
  readonly setup?: SetupFacts | undefined;
}

export const SETUP_COMPLETE_TEXT = [
  '✅ Всё настроено: worker, api, ключи AI, форма заявки, кнопка «Пульт» и доступы.',
  'Дальше система работает сама: карточки решений придут сюда, сводка — каждый день в 10:00. Сторож напишет, если что-то остановится.',
].join('\n');

export interface ServiceWatchdog {
  /** One check; returns the notices sent. */
  runOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export function createServiceWatchdog(options: ServiceWatchdogOptions): ServiceWatchdog {
  const { database, logger } = options;
  const nowMs = options.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;

  /** Opens the incident and tells the owner in one transaction: a failed delivery opens nothing. */
  async function report(
    incident: Pick<ServiceIncident, 'kind' | 'subject' | 'detail'>,
    text: string,
  ): Promise<number> {
    return database.transaction(async (scope) => {
      const opened = await scope.services.open({
        ...incident,
        at: toTimestamp(new Date(nowMs())),
      });
      if (opened === undefined) return 0;
      await options.deliver(text);
      return 1;
    });
  }

  async function close(incident: ServiceIncident, text: string): Promise<number> {
    return database.transaction(async (scope) => {
      if (!(await scope.services.resolve(incident.id, toTimestamp(new Date(nowMs()))))) return 0;
      await options.deliver(text);
      return 1;
    });
  }

  async function runOnce(): Promise<number> {
    const now = nowMs();
    const [heartbeats, open] = await Promise.all([
      database.services.heartbeats(),
      database.services.openIncidents(),
    ]);
    const openOf = (kind: ServiceIncident['kind'], subject: string) =>
      open.find((incident) => incident.kind === kind && incident.subject === subject);
    let sent = 0;

    for (const service of WATCHED) {
      const heartbeat = heartbeats.find((item) => item.service === service);
      // A service that never marked is not set up yet: the checklist in /status says so.
      if (heartbeat === undefined) continue;
      const silent = now - timestampMs(heartbeat.seenAt) > SILENT_AFTER_MS;
      const silentIncident = openOf('silent', service);
      if (silent && silentIncident === undefined) {
        sent += await report(
          { kind: 'silent', subject: service, detail: heartbeat.seenAt },
          silentText(service, heartbeat.seenAt, now),
        );
      } else if (!silent && silentIncident !== undefined) {
        sent += await close(
          silentIncident,
          recoveredText(service, silentIncident.detail as Timestamp, now),
        );
      }

      const versionIncident = openOf('version', service);
      const differs =
        !silent &&
        options.version !== 'dev' &&
        heartbeat.version !== 'dev' &&
        heartbeat.version !== options.version;
      if (differs && versionIncident === undefined) {
        if (now - options.startedAtMs > VERSION_GRACE_MS) {
          sent += await report(
            { kind: 'version', subject: service, detail: options.version },
            versionText(service, heartbeat.version, options.version),
          );
        }
      } else if (!differs && !silent && versionIncident !== undefined) {
        sent += await close(versionIncident, versionFixedText(service, heartbeat.version));
      }
    }

    sent += await watchAiKeys(now, open);
    if (options.setup !== undefined) sent += await announceSetup(options.setup, now);
    return sent;
  }

  /** Once, when the checklist of /status is complete for the first time. */
  async function announceSetup(facts: SetupFacts, now: number): Promise<number> {
    if (!(await setupStatus(database, facts, now)).complete) return 0;
    const key = 'setup-complete';
    const { outcome } = await database.command(
      { name: 'setup.complete', idempotencyKey: key, correlationId: key },
      async () => {
        await options.deliver(SETUP_COMPLETE_TEXT);
        return { sentAt: new Date(now).toISOString() };
      },
    );
    return outcome === 'executed' ? 1 : 0;
  }

  async function watchAiKeys(now: number, open: readonly ServiceIncident[]): Promise<number> {
    const [calls, lastSuccess] = await Promise.all([
      database.aiCalls.list({
        from: toTimestamp(new Date(now - AI_KEY_WINDOW_MS)),
        limit: 1_000,
      }),
      database.aiCalls.lastSuccess(),
    ]);
    let sent = 0;
    for (const provider of Object.keys(AI_PROVIDER_SETUP) as AiProvider[]) {
      const rejected = calls.filter(
        (call) =>
          call.provider === provider && call.outcome === 'failed' && call.failure === 'auth',
      );
      const success = lastSuccess[provider];
      const incident = open.find((item) => item.kind === 'ai_key' && item.subject === provider);
      const latest = rejected[0];
      if (incident === undefined && latest !== undefined) {
        // A success after the latest rejection means the key works again.
        if (success !== undefined && timestampMs(success) > timestampMs(latest.occurredAt))
          continue;
        sent += await report(
          {
            kind: 'ai_key',
            subject: provider,
            detail: new Date(now).toISOString().slice(0, 10),
          },
          aiKeyText(provider, rejected.length),
        );
      } else if (
        incident !== undefined &&
        success !== undefined &&
        timestampMs(success) > timestampMs(incident.openedAt)
      ) {
        sent += await close(incident, aiKeyFixedText(provider));
      }
    }
    return sent;
  }

  const tick = (): void => {
    if (running !== undefined) return;
    running = runOnce()
      .then((sent) => {
        if (sent > 0) logger.info('watchdog notices sent', { sent });
      })
      .catch((error: unknown) => {
        logger.warn('watchdog check failed', { error });
      })
      .finally(() => {
        running = undefined;
      });
  };

  return {
    runOnce,
    start() {
      if (timer !== undefined) return;
      tick();
      timer = setInterval(tick, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

// ---------------------------------------------------------------- Setup checklist

export interface SetupFacts {
  /** The bot has the api's address (`PUBLIC_API_URL`): the menu button «Пульт». */
  readonly publicApiUrl: boolean;
}

export interface SetupStatus {
  readonly complete: boolean;
  /** For /status: one line when complete, else every check with where to fix it. */
  readonly lines: readonly string[];
}

/** What is left to set up (D-023): the checklist of /status. */
export async function setupStatus(
  database: Database,
  facts: SetupFacts,
  nowMs: number,
): Promise<SetupStatus> {
  const [heartbeats, requests] = await Promise.all([
    database.services.heartbeats(),
    decidableRequests(database.repositories, toTimestamp(new Date(nowMs))),
  ]);
  const of = (service: ServiceName): ServiceHeartbeat | undefined =>
    heartbeats.find((item) => item.service === service);
  const state = (service: ServiceName): { ok: boolean; line: string } => {
    const heartbeat = of(service);
    if (heartbeat === undefined) {
      return { ok: false, line: `⚠️ ${service} не запущен — deploy/hetzner.md` };
    }
    if (nowMs - timestampMs(heartbeat.seenAt) > SILENT_AFTER_MS) {
      return {
        ok: false,
        line: `🔴 ${service} молчит с ${formatTime(heartbeat.seenAt)} — Hetzner → сервер → Reboot`,
      };
    }
    return { ok: true, line: `✅ ${service} работает · ${heartbeat.version}` };
  };

  const worker = state('worker');
  const api = state('api');
  const ai = of('worker')?.setup['ai'];
  const providers = Array.isArray(ai)
    ? ai.flatMap((name) =>
        Object.hasOwn(AI_PROVIDER_SETUP, name) ? [AI_PROVIDER_SETUP[name as AiProvider].name] : [],
      )
    : [];
  const free = of('worker')?.setup['ai_free'];
  const freeNote =
    Array.isArray(free) && free.includes('google') ? ' · бесплатный ключ Gemini — первым' : '';
  const form = of('api')?.setup['form'] === true;
  const access = requests.filter((request) => request.kind === 'access_grant').length;

  const checks: { readonly ok: boolean; readonly line: string }[] = [
    worker,
    {
      ok: providers.length > 0,
      line:
        providers.length > 0
          ? `✅ AI: ${providers.join(', ')}${freeNote}`
          : '⚠️ ключи AI не заданы у worker — deploy/hetzner.md, «Заменить ключ»',
    },
    api,
    {
      ok: form,
      line: form
        ? '✅ форма заявки на страницах тестов'
        : '⚠️ нет PUBLIC_CONTACT_EMAIL у api — deploy/hetzner.md, «Заменить ключ»',
    },
    {
      ok: facts.publicApiUrl,
      line: facts.publicApiUrl
        ? '✅ кнопка «Пульт»'
        : '⚠️ нет PUBLIC_API_URL у бота — deploy/hetzner.md',
    },
    {
      ok: access === 0,
      line: access === 0 ? '✅ доступы решены' : `⚠️ доступов ждут: ${String(access)} — /decisions`,
    },
  ];
  const left = checks.filter((check) => !check.ok).length;
  if (left === 0) {
    return {
      complete: true,
      lines: [
        `🧭 Запуск: всё настроено ✅ (worker ${of('worker')?.version ?? ''}, api ${of('api')?.version ?? ''})`,
      ],
    };
  }
  return {
    complete: false,
    lines: [`🧭 Запуск — осталось ${String(left)}:`, ...checks.map((check) => check.line)],
  };
}
