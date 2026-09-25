import type postgres from 'postgres';
import type { EntityRef, EntityType, Timestamp } from '@roi-dealer/domain';
import {
  newEventSchema,
  storedEventSchema,
  type NewEvent,
  type StoredEvent,
} from '@roi-dealer/events';
import { DataIntegrityError, translated } from './errors.js';
import type { Executor, Row, TransactionSql } from './executor.js';
import { actor, instant, withoutNulls } from './rows.js';

export interface EventQuery {
  /** Inclusive lower bound of `occurredAt`. */
  readonly from?: Timestamp | undefined;
  /** Exclusive upper bound of `occurredAt`. */
  readonly to?: Timestamp | undefined;
  readonly aggregateType?: EntityType | undefined;
  /** Continue after this `position` (keyset pagination). */
  readonly after?: number | undefined;
  /** Default 100, at most 1 000. */
  readonly limit?: number | undefined;
}

/** Read access to Event History. Events are written only by the repositories. */
export interface EventStore {
  /** Every event of one entity, oldest version first. */
  history(aggregate: EntityRef): Promise<StoredEvent[]>;
  /** Events in recording order (`position`), filtered by period and entity type. */
  list(query?: EventQuery): Promise<StoredEvent[]>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

/** Appends one event; called by repositories inside the transaction of the change. */
export async function appendEvent(tx: TransactionSql, event: NewEvent): Promise<void> {
  const valid = newEventSchema.parse(event);
  await tx`
    insert into events (
      id, type, aggregate_type, aggregate_id, aggregate_version, occurred_at,
      actor_type, actor_id, correlation_id, payload
    ) values (
      ${valid.id}, ${valid.type}, ${valid.aggregate.type}, ${valid.aggregate.id},
      ${valid.aggregateVersion}, ${valid.occurredAt}, ${valid.actor.type}, ${valid.actor.id},
      ${valid.correlationId ?? null}, ${tx.json(valid.payload as postgres.JSONValue)}
    )
  `;
}

function readEvent(row: Row): StoredEvent {
  const parsed = storedEventSchema.safeParse(
    withoutNulls({
      position: Number(row['position']),
      id: row['id'],
      type: row['type'],
      aggregate: { type: row['aggregate_type'], id: row['aggregate_id'] },
      aggregateVersion: row['aggregate_version'],
      occurredAt: instant(row['occurred_at']),
      recordedAt: instant(row['recorded_at']),
      actor: actor(row['actor_type'], row['actor_id']),
      correlationId: row['correlation_id'],
      payload: row['payload'],
    }),
  );
  if (!parsed.success) {
    throw new DataIntegrityError(
      'event',
      String(row['id']),
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

export function createEventStore(executor: Executor): EventStore {
  return {
    history: (aggregate) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select * from events
          where aggregate_type = ${aggregate.type} and aggregate_id = ${aggregate.id}
          order by aggregate_version
        `;
        return rows.map(readEvent);
      }),

    list: (query = {}) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const rows = await executor<Row[]>`
          select * from events
          where true
            ${query.from === undefined ? executor`` : executor`and occurred_at >= ${query.from}`}
            ${query.to === undefined ? executor`` : executor`and occurred_at < ${query.to}`}
            ${query.aggregateType === undefined ? executor`` : executor`and aggregate_type = ${query.aggregateType}`}
            ${query.after === undefined ? executor`` : executor`and position > ${query.after}`}
          order by position
          limit ${limit}
        `;
        return rows.map(readEvent);
      }),
  };
}
