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
/** The backup runs nightly (02:30 UTC): with no successful one for this long, it failed. */
export const BACKUP_SILENT_AFTER_MS = 26 * 60 * 60_000;
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

/**
 * Where the services run (D-029, D-032): the watchdog's hints name the steps of that host. The
 * bot knows it from the variables Railway sets on its own; elsewhere it is the Hetzner server.
 */
export const HOSTINGS = ['hetzner', 'railway'] as const;
export type Hosting = (typeof HOSTINGS)[number];

interface HostingHints {
  /** How to restart a silent service, without losing data. */
  readonly restart: (service: ServiceName) => string;
  /** What to do when the versions stay apart. */
  readonly update: string;
  /** Where a variable is replaced. */
  readonly replace: (variable: string, service: ServiceName) => string;
  /** The guide of the host. */
  readonly guide: string;
  /** Short restart step for the /status checklist. */
  readonly restartShort: (service: ServiceName) => string;
  /** Where to set a missing variable, for the /status checklist. */
  readonly setting: (variable: string, service: ServiceName) => string;
}

export const HOSTING_HINTS: Readonly<Record<Hosting, HostingHints>> = {
  hetzner: {
    restart: () =>
      'Hetzner → сервер → Power → Reboot перезапустит сервисы, данные сохранятся (deploy/hetzner.md)',
    update:
      'Сервер обновляется сам раз в 5 минут. Если версии не сойдутся за час — Hetzner → сервер → Power → Reboot.',
    replace: (variable) => `Замените ${variable} — deploy/hetzner.md, «Заменить ключ»`,
    guide: 'deploy/hetzner.md',
    restartShort: () => 'Hetzner → сервер → Reboot',
    setting: () => 'deploy/hetzner.md, «Заменить ключ»',
  },
  railway: {
    restart: (service) =>
      `Railway → ${service} → Deployments → ⋮ у последнего деплоя → Restart, данные сохранятся (deploy/START.md)`,
    update:
      'Railway → сервис → Deployments: если последний деплой упал или ждёт в очереди — ⋮ → Redeploy. Если очередь стоит — status.railway.com.',
    replace: (variable, service) =>
      `Railway → ${service} → Variables → ${variable}: замените значение, сервис перезапустится сам`,
    guide: 'deploy/START.md',
    restartShort: (service) => `Railway → ${service} → Deployments → Restart`,
    setting: (variable, service) => `Railway → ${service} → Variables → ${variable}`,
  },
};

function minutes(fromMs: number, toMs: number): string {
  return `${String(Math.max(1, Math.round((toMs - fromMs) / 60_000)))} мин`;
}

export function silentText(
  service: ServiceName,
  lastSeen: Timestamp,
  nowMs: number,
  hosting: Hosting = 'hetzner',
): string {
  return [
    `🔴 ${service} молчит ${minutes(timestampMs(lastSeen), nowMs)}: последняя отметка ${formatTime(lastSeen)} (Киев).`,
    `${HOSTING_HINTS[hosting].restart(service)}. Когда ${service} заработает, я напишу.`,
  ].join('\n');
}

export function recoveredText(service: ServiceName, lastSeen: Timestamp, nowMs: number): string {
  return `🟢 ${service} снова работает (молчал около ${minutes(timestampMs(lastSeen), nowMs)}).`;
}

function hours(fromMs: number, toMs: number): string {
  return `${String(Math.max(1, Math.round((toMs - fromMs) / 3_600_000)))} ч`;
}

export function backupMissedText(lastSuccess: Timestamp, nowMs: number): string {
  return [
    `🔴 Ночной бэкап не прошёл: последний успешный — ${formatTime(lastSuccess)} (Киев), ${hours(timestampMs(lastSuccess), nowMs)} назад.`,
    'На сервере: journalctl -u roi-dealer-backup и свободное место на диске — deploy/hetzner.md, «Бэкапы». Когда бэкап пройдёт, я напишу.',
  ].join('\n');
}

export function backupRecoveredText(heartbeat: Pick<ServiceHeartbeat, 'setup'>): string {
  const reserve = heartbeat.setup['reserve'] === true ? ', копия в резерве обновлена' : '';
  return `🟢 Бэкап снова прошёл${reserve}.`;
}

/** For /status: the last successful backup; not part of the launch checklist. */
export function backupStatusLine(
  heartbeats: readonly ServiceHeartbeat[],
  nowMs: number,
  hosting: Hosting = 'hetzner',
): string {
  const backup = heartbeats.find((item) => item.service === 'backup');
  if (backup === undefined) {
    return hosting === 'railway'
      ? '💾 Бэкап: на Railway — вкладка Backups сервиса Postgres (deploy/START.md)'
      : '💾 Бэкап: ещё не было (ночью на сервере Hetzner)';
  }
  const reserve = backup.setup['reserve'] === true ? ' · копия в резерве' : '';
  const late = nowMs - timestampMs(backup.seenAt) > BACKUP_SILENT_AFTER_MS ? '🔴' : '💾';
  return `${late} Бэкап: последний ${formatTime(backup.seenAt)} (Киев)${reserve}`;
}

export function versionText(
  service: ServiceName,
  serviceVersion: string,
  bot: string,
  hosting: Hosting = 'hetzner',
): string {
  return [
    `⚠️ Версии разошлись: бот — ${bot}, ${service} — ${serviceVersion}. Последний деплой одного из них не прошёл.`,
    HOSTING_HINTS[hosting].update,
  ].join('\n');
}

export function versionFixedText(service: ServiceName, version: string): string {
  return `✅ ${service} на той же версии, что и бот (${version}).`;
}

export function aiKeyText(
  provider: AiProvider,
  rejected: number,
  hosting: Hosting = 'hetzner',
): string {
  const { name, variable } = AI_PROVIDER_SETUP[provider];
  return [
    `🔑 Ключ ${name} не принят: ${String(rejected)} вызовов за час с ошибкой доступа.`,
    `${HOSTING_HINTS[hosting].replace(variable, 'worker')} — и проверьте баланс в кабинете провайдера. Пока работают другие провайдеры.`,
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
  /** Where the services run: the hints name its steps. Default: Hetzner. */
  readonly hosting?: Hosting | undefined;
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
  const hosting = options.hosting ?? options.setup?.hosting ?? 'hetzner';
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
          silentText(service, heartbeat.seenAt, now, hosting),
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
            versionText(service, heartbeat.version, options.version, hosting),
          );
        }
      } else if (!differs && !silent && versionIncident !== undefined) {
        sent += await close(versionIncident, versionFixedText(service, heartbeat.version));
      }
    }

    sent += await watchBackup(now, heartbeats, open);
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

  /** A backup that never ran (not moved to Hetzner yet) is not reported. */
  async function watchBackup(
    now: number,
    heartbeats: readonly ServiceHeartbeat[],
    open: readonly ServiceIncident[],
  ): Promise<number> {
    const backup = heartbeats.find((item) => item.service === 'backup');
    if (backup === undefined) return 0;
    const missed = now - timestampMs(backup.seenAt) > BACKUP_SILENT_AFTER_MS;
    const incident = open.find((item) => item.kind === 'silent' && item.subject === 'backup');
    if (missed && incident === undefined) {
      return report(
        { kind: 'silent', subject: 'backup', detail: backup.seenAt },
        backupMissedText(backup.seenAt, now),
      );
    }
    if (!missed && incident !== undefined) return close(incident, backupRecoveredText(backup));
    return 0;
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
          aiKeyText(provider, rejected.length, hosting),
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
  /** Where the services run: the checklist names its guide and steps. Default: Hetzner. */
  readonly hosting?: Hosting | undefined;
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
  const hints = HOSTING_HINTS[facts.hosting ?? 'hetzner'];
  const state = (service: ServiceName): { ok: boolean; line: string } => {
    const heartbeat = of(service);
    if (heartbeat === undefined) {
      return { ok: false, line: `⚠️ ${service} не запущен — ${hints.guide}` };
    }
    if (nowMs - timestampMs(heartbeat.seenAt) > SILENT_AFTER_MS) {
      return {
        ok: false,
        line: `🔴 ${service} молчит с ${formatTime(heartbeat.seenAt)} — ${hints.restartShort(service)}`,
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
          : `⚠️ ключи AI не заданы у worker — ${hints.setting('GEMINI_API_KEY', 'worker')}`,
    },
    api,
    {
      ok: form,
      line: form
        ? '✅ форма заявки на страницах тестов'
        : `⚠️ нет PUBLIC_CONTACT_EMAIL у api — ${hints.setting('PUBLIC_CONTACT_EMAIL', 'api')}`,
    },
    {
      ok: facts.publicApiUrl,
      line: facts.publicApiUrl
        ? '✅ кнопка «Пульт»'
        : `⚠️ нет PUBLIC_API_URL у бота — ${hints.guide}`,
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
