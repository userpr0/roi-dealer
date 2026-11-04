import { translated } from './errors.js';
import type { Executor } from './executor.js';

/* Topics the owner asks the research agent to search (/seek, migration 0026). */

export interface SeekTopic {
  readonly id: number;
  readonly query: string;
  readonly createdAt: string;
  /** Present once searched. */
  readonly evidence?: number | undefined;
}

export interface SeekQueries {
  add(entry: {
    readonly query: string;
    readonly actorId: string;
    readonly correlationId?: string | undefined;
  }): Promise<void>;
  /** Topics not searched yet, oldest first. */
  pending(limit: number): Promise<SeekTopic[]>;
  /** Throws `ConstraintViolationError` for a second run of a topic. */
  recordRun(topicId: number, evidence: number): Promise<void>;
  /** The latest topics with their results, newest first. */
  list(limit: number): Promise<SeekTopic[]>;
}

type Row = { id: string; query: string; created_at: Date; evidence: number | null };
const topic = (row: Row): SeekTopic => ({
  id: Number(row.id),
  query: row.query,
  createdAt: row.created_at.toISOString(),
  ...(row.evidence === null ? {} : { evidence: Number(row.evidence) }),
});

export function createSeekQueries(executor: Executor): SeekQueries {
  return {
    add: (entry) =>
      translated(async () => {
        await executor`
          insert into seek_topics (query, actor_id, correlation_id)
          values (${entry.query}, ${entry.actorId}, ${entry.correlationId ?? null})
        `;
      }),
    pending: (limit) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select t.id::text as id, t.query, t.created_at, null::integer as evidence
          from seek_topics t left join seek_runs r on r.topic_id = t.id
          where r.topic_id is null order by t.id limit ${Math.max(1, Math.min(limit, 20))}
        `;
        return rows.map(topic);
      }),
    recordRun: (topicId, evidence) =>
      translated(async () => {
        await executor`insert into seek_runs (topic_id, evidence) values (${topicId}, ${evidence})`;
      }),
    list: (limit) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select t.id::text as id, t.query, t.created_at, r.evidence
          from seek_topics t left join seek_runs r on r.topic_id = t.id
          order by t.id desc limit ${Math.max(1, Math.min(limit, 50))}
        `;
        return rows.map(topic);
      }),
  };
}
