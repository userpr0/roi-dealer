import {
  toTimestamp,
  type ActorType,
  type LibraryNodes,
  type LibraryTopicId,
  type LibraryTree,
  type Pain,
  type Timestamp,
} from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import type { Repositories } from './repositories.js';
import { readRows } from './repository.js';
import {
  libraryProjectsTable,
  libraryTopicsTable,
  libraryVerticalsTable,
  painsTable,
} from './tables.js';

/*
 * The library's filing journal (phase 35, ADR-0016, migration 0028): which topic an object is
 * filed under. Append-only: the latest row of an object counts, a move is a new row.
 */

export const LIBRARY_OBJECT_TYPES = ['pain', 'opportunity'] as const;
export type LibraryObjectType = (typeof LIBRARY_OBJECT_TYPES)[number];

export interface LibraryFilingEntry {
  readonly objectType: LibraryObjectType;
  readonly objectId: string;
  readonly topicId: LibraryTopicId;
  readonly actorType: Extract<ActorType, 'owner' | 'agent' | 'system'>;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

/** Where an object is now. */
export interface LibraryFiling {
  readonly objectType: LibraryObjectType;
  readonly objectId: string;
  readonly topicId: LibraryTopicId;
  readonly filedAt: Timestamp;
  readonly byOwner: boolean;
}

export interface LibraryQueries {
  file(entry: LibraryFilingEntry): Promise<void>;
  /** The active verticals, projects and topics, oldest first. */
  tree(): Promise<LibraryTree>;
  /** Where every filed object is now; at most 5 000, newest filings first. */
  filings(options?: {
    readonly objectType?: LibraryObjectType | undefined;
    readonly topicId?: LibraryTopicId | undefined;
    readonly limit?: number | undefined;
  }): Promise<LibraryFiling[]>;
  /** The topic of one object, if it is filed. */
  topicOf(objectType: LibraryObjectType, objectId: string): Promise<LibraryTopicId | undefined>;
  /**
   * Open pains that are not filed and whose current version the agent has not tried; oldest
   * first. Default 5, at most 50.
   */
  pendingPains(options: { readonly agent: string; readonly limit?: number }): Promise<Pain[]>;
  /**
   * Opportunities that are not filed while one of their pains is: the opportunity goes where
   * its first filed pain is. At most 100.
   */
  pendingOpportunities(): Promise<
    { readonly opportunityId: string; readonly topicId: LibraryTopicId }[]
  >;
  /** Objects filed or moved since `from` (each object once). */
  filedSince(from: Timestamp): Promise<number>;
}

const MAX_FILINGS = 5_000;

/** The latest filing of every object. */
const current = (executor: Executor) => executor`
  select distinct on (object_type, object_id) object_type, object_id, topic_id, filed_at, actor_type
  from library_filings order by object_type, object_id, id desc
`;

export function createLibraryQueries(executor: Executor): LibraryQueries {
  return {
    file: (entry) =>
      translated(async () => {
        await executor`
          insert into library_filings (
            object_type, object_id, topic_id, actor_type, actor_id, correlation_id
          ) values (
            ${entry.objectType}, ${entry.objectId}, ${entry.topicId}, ${entry.actorType},
            ${entry.actorId}, ${entry.correlationId ?? null}
          )
        `;
      }),

    tree: () =>
      translated(async () => {
        const [verticals, projects, topics] = await Promise.all([
          executor<Row[]>`
            select * from library_verticals where status = 'active' order by created_at, id`,
          executor<Row[]>`
            select * from library_projects where status = 'active' order by created_at, id`,
          executor<Row[]>`
            select * from library_topics where status = 'active' order by created_at, id`,
        ]);
        return {
          verticals: await readRows(executor, libraryVerticalsTable, verticals),
          projects: await readRows(executor, libraryProjectsTable, projects),
          topics: await readRows(executor, libraryTopicsTable, topics),
        };
      }),

    filings: (options = {}) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? MAX_FILINGS), 1), MAX_FILINGS);
        const rows = await executor<
          {
            object_type: LibraryObjectType;
            object_id: string;
            topic_id: LibraryTopicId;
            filed_at: Date;
            actor_type: string;
          }[]
        >`
          select * from (${current(executor)}) f
          where true
          ${options.objectType === undefined ? executor`` : executor`and f.object_type = ${options.objectType}`}
          ${options.topicId === undefined ? executor`` : executor`and f.topic_id = ${options.topicId}`}
          order by f.filed_at desc, f.object_id
          limit ${limit}
        `;
        return rows.map((row) => ({
          objectType: row.object_type,
          objectId: row.object_id,
          topicId: row.topic_id,
          filedAt: toTimestamp(row.filed_at),
          byOwner: row.actor_type === 'owner',
        }));
      }),

    topicOf: (objectType, objectId) =>
      translated(async () => {
        const rows = await executor<{ topic_id: LibraryTopicId }[]>`
          select topic_id from library_filings
          where object_type = ${objectType} and object_id = ${objectId}
          order by id desc limit 1
        `;
        return rows[0]?.topic_id;
      }),

    pendingPains: (options) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? 5), 1), 50);
        const rows = await executor<Row[]>`
          select p.* from pains p
          where p.status in ('candidate', 'validated')
            and not exists (
              select 1 from library_filings f
              where f.object_type = 'pain' and f.object_id = p.id
            )
            and not exists (
              select 1 from agent_work w
              where w.agent = ${options.agent} and w.subject_type = 'pain'
                and w.subject_id = p.id and w.subject_version = p.version
            )
          order by p.created_at, p.id
          limit ${limit}
        `;
        return readRows(executor, painsTable, rows);
      }),

    pendingOpportunities: () =>
      translated(async () => {
        const rows = await executor<{ opportunity_id: string; topic_id: LibraryTopicId }[]>`
          select distinct on (o.id) o.id as opportunity_id, f.topic_id
          from opportunities o
          join opportunity_pains op on op.opportunity_id = o.id
          join (${current(executor)}) f on f.object_type = 'pain' and f.object_id = op.pain_id
          where not exists (
            select 1 from library_filings own
            where own.object_type = 'opportunity' and own.object_id = o.id
          )
          order by o.id, op.position
          limit 100
        `;
        return rows.map((row) => ({ opportunityId: row.opportunity_id, topicId: row.topic_id }));
      }),

    filedSince: (from) =>
      translated(async () => {
        const rows = await executor<{ count: string }[]>`
          select count(*) as count from (
            select distinct object_type, object_id from library_filings where filed_at >= ${from}
          ) filed
        `;
        return Number(rows[0]?.count ?? 0);
      }),
  };
}

/** Stores the new nodes of a place; run it in the transaction of the filing they are for. */
export async function storeLibraryNodes(
  repositories: Pick<Repositories, 'libraryVerticals' | 'libraryProjects' | 'libraryTopics'>,
  nodes: Pick<LibraryNodes, 'vertical' | 'project' | 'created'>,
): Promise<void> {
  if (nodes.vertical !== undefined) await repositories.libraryVerticals.insert(nodes.vertical);
  if (nodes.project !== undefined) await repositories.libraryProjects.insert(nodes.project);
  if (nodes.created !== undefined) await repositories.libraryTopics.insert(nodes.created);
}
