import type { ActorType, Timestamp } from '@roi-dealer/domain';
import type { DenialReason } from '@roi-dealer/policies';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { instant, withoutNulls } from './rows.js';

export const ACCESS_CHANNELS = ['telegram', 'database'] as const;
export type AccessChannel = (typeof ACCESS_CHANNELS)[number];

/** One access check: a view of the command center or a refused attempt (PHASE 04). */
export interface AccessLogEntry {
  /** Default: the database clock. */
  readonly occurredAt?: Timestamp | undefined;
  readonly channel: AccessChannel;
  /** Absent for an unknown sender, who is identified only by `actorId` (`telegram:<id>`). */
  readonly actorType?: ActorType | undefined;
  readonly actorId: string;
  /** A permission of @roi-dealer/policies, e.g. `journal.read`. */
  readonly permission: string;
  readonly decision: 'allowed' | 'denied';
  /** Present exactly for denials. */
  readonly reason?: DenialReason | undefined;
  readonly correlationId?: string | undefined;
}

export interface StoredAccessLogEntry extends AccessLogEntry {
  readonly id: number;
  readonly occurredAt: Timestamp;
}

export interface AccessLogQuery {
  /** Inclusive lower bound of `occurredAt`. */
  readonly from?: Timestamp | undefined;
  /** Exclusive upper bound of `occurredAt`. */
  readonly to?: Timestamp | undefined;
  readonly decision?: 'allowed' | 'denied' | undefined;
  /** Default 50, at most 1 000. */
  readonly limit?: number | undefined;
}

/** The access log: only appended to, never changed (migration 0004). */
export interface AccessLog {
  record(entry: AccessLogEntry): Promise<void>;
  /** Newest first. */
  list(query?: AccessLogQuery): Promise<StoredAccessLogEntry[]>;
  count(query?: Omit<AccessLogQuery, 'limit'>): Promise<number>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1_000;

function readEntry(row: Row): StoredAccessLogEntry {
  return withoutNulls({
    id: Number(row['id']),
    occurredAt: instant(row['occurred_at']),
    channel: row['channel'],
    actorType: row['actor_type'],
    actorId: row['actor_id'],
    permission: row['permission'],
    decision: row['decision'],
    reason: row['reason'],
    correlationId: row['correlation_id'],
  }) as unknown as StoredAccessLogEntry;
}

export function createAccessLog(executor: Executor): AccessLog {
  const filters = (query: Omit<AccessLogQuery, 'limit'>) => executor`
    ${query.from === undefined ? executor`` : executor`and occurred_at >= ${query.from}`}
    ${query.to === undefined ? executor`` : executor`and occurred_at < ${query.to}`}
    ${query.decision === undefined ? executor`` : executor`and decision = ${query.decision}`}
  `;

  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into access_log (
            occurred_at, channel, actor_type, actor_id, permission, decision, reason,
            correlation_id
          ) values (
            coalesce(${entry.occurredAt ?? null}::timestamptz, now()), ${entry.channel},
            ${entry.actorType ?? null}, ${entry.actorId}, ${entry.permission}, ${entry.decision},
            ${entry.reason ?? null}, ${entry.correlationId ?? null}
          )
        `;
      }),

    list: (query = {}) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const rows = await executor<Row[]>`
          select * from access_log where true ${filters(query)}
          order by id desc
          limit ${limit}
        `;
        return rows.map(readEntry);
      }),

    count: (query = {}) =>
      translated(async () => {
        const [row] = await executor<{ count: string }[]>`
          select count(*) as count from access_log where true ${filters(query)}
        `;
        return Number(row?.count ?? 0);
      }),
  };
}
