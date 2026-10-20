import { z } from 'zod';
import { timestampSchema, type Timestamp } from '@roi-dealer/domain';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { instant } from './rows.js';

/*
 * The service watchdog's journals (13c, migration 0019): each service marks once a minute that
 * it runs, and the bot records what it told the owner about them. Operational data only: no
 * events, no personal data, no secrets — the setup holds names and switches, never values.
 */

export const SERVICES = ['bot', 'worker', 'api'] as const;
export type ServiceName = (typeof SERVICES)[number];

export const INCIDENT_KINDS = ['silent', 'version', 'ai_key'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** What a service has configured: switches and names, e.g. `{ ai: ['anthropic'], form: true }`. */
export const serviceSetupSchema = z
  .record(
    z.string().regex(/^[a-z_]{1,20}$/),
    z.union([z.boolean(), z.array(z.string().regex(/^[a-z0-9_-]{1,20}$/)).max(10)]),
  )
  .refine((setup) => Object.keys(setup).length <= 10, { error: 'at most 10 settings' });
export type ServiceSetup = z.infer<typeof serviceSetupSchema>;

export interface ServiceHeartbeat {
  readonly service: ServiceName;
  readonly version: string;
  readonly startedAt: Timestamp;
  readonly seenAt: Timestamp;
  readonly setup: ServiceSetup;
}

export interface ServiceIncident {
  readonly id: string;
  readonly kind: IncidentKind;
  /** The service (`silent`, `version`) or the AI provider (`ai_key`). */
  readonly subject: string;
  /** What identifies the incident: the last mark, the expected version, the day. */
  readonly detail: string;
  readonly openedAt: Timestamp;
  readonly resolvedAt?: Timestamp | undefined;
}

export interface ServiceWatch {
  /** Marks that the service runs; `at` defaults to the database clock. */
  beat(mark: {
    readonly service: ServiceName;
    readonly version: string;
    readonly startedAt: Timestamp;
    readonly setup: ServiceSetup;
    readonly at?: Timestamp | undefined;
  }): Promise<void>;
  heartbeats(): Promise<ServiceHeartbeat[]>;
  /**
   * Opens an incident; `undefined` when one of this kind and subject is open, or this very
   * incident was reported before — so each is told to the owner once.
   */
  open(incident: {
    readonly kind: IncidentKind;
    readonly subject: string;
    readonly detail: string;
    readonly at: Timestamp;
  }): Promise<ServiceIncident | undefined>;
  /** Closes an open incident; `false` when it was closed already. */
  resolve(id: string, at: Timestamp): Promise<boolean>;
  openIncidents(): Promise<ServiceIncident[]>;
  /** Incidents opened since `from`, newest first. */
  incidentsSince(from: Timestamp): Promise<ServiceIncident[]>;
}

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

function readHeartbeat(row: Row): ServiceHeartbeat {
  return {
    service: row['service'] as ServiceName,
    version: String(row['version']),
    startedAt: timestampSchema.parse(instant(row['started_at'])),
    seenAt: timestampSchema.parse(instant(row['seen_at'])),
    setup: serviceSetupSchema.catch({}).parse(row['setup']),
  };
}

function readIncident(row: Row): ServiceIncident {
  const resolvedAt = row['resolved_at'];
  return {
    id: String(row['id']),
    kind: row['kind'] as IncidentKind,
    subject: String(row['subject']),
    detail: String(row['detail']),
    openedAt: timestampSchema.parse(instant(row['opened_at'])),
    ...(resolvedAt === null || resolvedAt === undefined
      ? {}
      : { resolvedAt: timestampSchema.parse(instant(resolvedAt)) }),
  };
}

export function createServiceWatch(executor: Executor): ServiceWatch {
  return {
    beat: (mark) =>
      translated(async () => {
        if (!VERSION.test(mark.version)) throw new Error('invalid service version');
        const setup = serviceSetupSchema.parse(mark.setup);
        const at = mark.at ?? null;
        // A clock ahead of the database's must not start a service after its own mark.
        await executor`
          insert into service_heartbeats (service, version, started_at, seen_at, setup)
          values (
            ${mark.service}, ${mark.version},
            least(${mark.startedAt}::timestamptz, coalesce(${at}::timestamptz, now())),
            coalesce(${at}::timestamptz, now()), ${executor.json(setup)}
          )
          on conflict (service) do update set
            version = excluded.version, started_at = excluded.started_at,
            seen_at = excluded.seen_at, setup = excluded.setup
        `;
      }),

    heartbeats: () =>
      translated(async () => {
        const rows = await executor<Row[]>`select * from service_heartbeats order by service`;
        return rows.map(readHeartbeat);
      }),

    open: (incident) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          insert into service_incidents (id, kind, subject, detail, opened_at)
          values (${uuidv7()}, ${incident.kind}, ${incident.subject}, ${incident.detail},
                  ${incident.at})
          on conflict do nothing
          returning *
        `;
        const [row] = rows;
        return row === undefined ? undefined : readIncident(row);
      }),

    resolve: (id, at) =>
      translated(async () => {
        const rows = await executor`
          update service_incidents set resolved_at = greatest(${at}::timestamptz, opened_at)
          where id = ${id} and resolved_at is null
          returning id
        `;
        return rows.length > 0;
      }),

    openIncidents: () =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select * from service_incidents where resolved_at is null order by opened_at
        `;
        return rows.map(readIncident);
      }),

    incidentsSince: (from) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select * from service_incidents where opened_at >= ${from}
          order by opened_at desc, kind, subject limit 100
        `;
        return rows.map(readIncident);
      }),
  };
}

export interface ServiceHeartbeatOptions {
  readonly watch: Pick<ServiceWatch, 'beat'>;
  readonly service: ServiceName;
  readonly version: string;
  readonly setup: ServiceSetup;
  readonly logger: Logger;
  /** Default: one minute. */
  readonly intervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ServiceHeartbeatTimer {
  start(): void;
  stop(): Promise<void>;
}

/** Marks the service as running now and then every interval; a failed mark is only logged. */
export function createServiceHeartbeat(options: ServiceHeartbeatOptions): ServiceHeartbeatTimer {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString() as Timestamp;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const beat = (): void => {
    if (running !== undefined) return;
    running = options.watch
      .beat({
        service: options.service,
        version: options.version,
        startedAt,
        setup: options.setup,
      })
      .catch((error: unknown) => {
        options.logger.warn('service heartbeat not recorded', { error });
      })
      .finally(() => {
        running = undefined;
      });
  };

  return {
    start() {
      if (timer !== undefined) return;
      beat();
      timer = setInterval(beat, options.intervalMs ?? 60_000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
