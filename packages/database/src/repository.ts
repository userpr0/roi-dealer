import type { z } from 'zod';
import type { Actor, EntityType, Timestamp } from '@roi-dealer/domain';
import { entityEventType, eventIdSchema } from '@roi-dealer/events';
import { uuidv7 } from '@roi-dealer/shared';
import {
  ConcurrencyError,
  ConstraintViolationError,
  DataIntegrityError,
  InvalidWriteError,
  NotFoundError,
  translated,
} from './errors.js';
import { appendEvent } from './event-store.js';
import { atomic, type Executor, type Row, type TransactionSql } from './executor.js';
import type { Columns } from './rows.js';

/** An ordered list of ids stored in a link table, e.g. `Signal.evidenceIds` → `signal_evidence`. */
export interface LinkSpec<E> {
  readonly table: string;
  /** Column that references the entity itself. */
  readonly parentColumn: string;
  /** Column that references the linked entity. */
  readonly childColumn: string;
  ids(entity: E): readonly string[];
}

/** Fields every stored entity has. */
export interface StoredEntity {
  readonly id: string;
  readonly createdAt: Timestamp;
  readonly createdBy: Actor;
}

export interface VersionedEntity extends StoredEntity {
  readonly status: string;
  readonly updatedAt: Timestamp;
  readonly version: number;
}

/** How one domain entity maps to its table and link tables. */
export interface TableSpec<E extends StoredEntity> {
  readonly entity: EntityType;
  readonly table: string;
  /** Domain schema: every row read back is validated with it (§2.13). */
  readonly schema: z.ZodType<E>;
  readonly links: Readonly<Record<string, LinkSpec<E>>>;
  toColumns(entity: E): Columns;
  /** Builds the raw domain object from a row and its link lists (keyed like `links`). */
  fromRow(row: Row, links: Readonly<Record<string, readonly string[]>>): unknown;
}

/** Applies to every event written through these repositories. */
export interface WriteContext {
  /** Request or update that caused the writes (`x-correlation-id`, `tg-update-<id>`). */
  readonly correlationId?: string | undefined;
}

export interface Repository<E extends StoredEntity> {
  /**
   * Stores a new entity with its link rows and its `<entity>.created` event (actor:
   * `createdBy`) in one transaction. Versioned entities are stored at version 1.
   */
  insert(entity: E): Promise<void>;
  getById(id: E['id']): Promise<E | undefined>;
  /** Returns the entities that exist, in the order of `ids`. */
  getByIds(ids: readonly E['id'][]): Promise<E[]>;
}

export interface VersionedRepository<E extends VersionedEntity> extends Repository<E> {
  /**
   * Stores the next version of an entity (as returned by a domain function: `version + 1`)
   * and its `<entity>.updated` event. `actor` is who made the change: the same actor as in
   * the domain context of the transition.
   * Throws `ConcurrencyError` when the stored version is not `entity.version - 1`,
   * `NotFoundError` when the entity does not exist.
   */
  update(entity: E, actor: Actor): Promise<void>;
}

/** The entity as it is stored in the event payload: plain JSON (absent fields dropped). */
function snapshotOf(entity: StoredEntity): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entity)) as Record<string, unknown>;
}

async function loadLinks<E>(
  executor: Executor,
  spec: LinkSpec<E>,
  parentIds: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await executor<{ parent: string; child: string }[]>`
    select ${executor(spec.parentColumn)} as parent, ${executor(spec.childColumn)} as child
    from ${executor(spec.table)}
    where ${executor(spec.parentColumn)} = any(${parentIds}::uuid[])
    order by ${executor(spec.parentColumn)}, position
  `;
  const byParent = new Map<string, string[]>();
  for (const { parent, child } of rows) {
    const children = byParent.get(parent);
    if (children === undefined) byParent.set(parent, [child]);
    else children.push(child);
  }
  return byParent;
}

async function insertLinks<E>(
  tx: TransactionSql,
  spec: LinkSpec<E>,
  parentId: string,
  childIds: readonly string[],
  firstPosition: number,
): Promise<void> {
  if (childIds.length === 0) return;
  const rows = childIds.map((childId, index) => ({
    [spec.parentColumn]: parentId,
    [spec.childColumn]: childId,
    position: firstPosition + index,
  }));
  await tx`insert into ${tx(spec.table)} ${tx(rows)}`;
}

/**
 * Link rows are append-only: an update may add ids after the stored ones
 * (e.g. the result assets of a completed experiment) but never remove or reorder them.
 */
async function appendLinks<E extends StoredEntity>(
  tx: TransactionSql,
  spec: LinkSpec<E>,
  entity: E,
): Promise<void> {
  const stored = (await loadLinks(tx, spec, [entity.id])).get(entity.id) ?? [];
  const next = spec.ids(entity);
  const keepsStored =
    stored.length <= next.length && stored.every((childId, index) => next[index] === childId);
  if (!keepsStored) {
    throw new ConstraintViolationError(
      'forbidden_change',
      '23001',
      `${spec.table}_delete_forbidden`,
      spec.table,
    );
  }
  await insertLinks(tx, spec, entity.id, next.slice(stored.length), stored.length);
}

function createReader<E extends StoredEntity>(
  executor: Executor,
  spec: TableSpec<E>,
): Pick<Repository<E>, 'getById' | 'getByIds'> {
  const linkEntries = Object.entries(spec.links);

  async function getByIds(ids: readonly E['id'][]): Promise<E[]> {
    if (ids.length === 0) return [];
    return translated(async () => {
      const rows = await executor<Row[]>`
        select * from ${executor(spec.table)} where id = any(${ids}::uuid[])
      `;
      const foundIds = rows.map((row) => String(row['id']));
      const links = await Promise.all(
        linkEntries.map(
          async ([name, link]) => [name, await loadLinks(executor, link, foundIds)] as const,
        ),
      );
      const byId = new Map<string, E>();
      for (const row of rows) {
        const id = String(row['id']);
        const lists = Object.fromEntries(links.map(([name, map]) => [name, map.get(id) ?? []]));
        const parsed = spec.schema.safeParse(spec.fromRow(row, lists));
        if (!parsed.success) {
          throw new DataIntegrityError(
            spec.entity,
            id,
            parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          );
        }
        byId.set(id, parsed.data);
      }
      return ids.flatMap((id) => {
        const entity = byId.get(id);
        return entity === undefined ? [] : [entity];
      });
    });
  }

  return {
    getByIds,
    async getById(id) {
      const [entity] = await getByIds([id]);
      return entity;
    },
  };
}

function createInsert<E extends StoredEntity>(
  executor: Executor,
  spec: TableSpec<E>,
  context: WriteContext,
): Repository<E>['insert'] {
  return (entity) =>
    translated(() =>
      atomic(executor, async (tx) => {
        const version =
          'version' in entity && typeof entity.version === 'number' ? entity.version : 1;
        if (version !== 1) {
          throw new InvalidWriteError(
            'insert_requires_version_1',
            `${spec.entity} ${entity.id} must be stored at version 1, then updated version by version`,
          );
        }
        await tx`insert into ${tx(spec.table)} ${tx(spec.toColumns(entity))}`;
        for (const link of Object.values(spec.links)) {
          await insertLinks(tx, link, entity.id, link.ids(entity), 0);
        }
        await appendEvent(tx, {
          id: eventIdSchema.parse(uuidv7()),
          type: entityEventType(spec.entity, 'created'),
          aggregate: { type: spec.entity, id: entity.id },
          aggregateVersion: 1,
          occurredAt: entity.createdAt,
          actor: entity.createdBy,
          correlationId: context.correlationId,
          payload: { snapshot: snapshotOf(entity) },
        });
      }),
    );
}

/** Repository of an append-only record (Evidence, Decision, CostEntry, KnowledgeAsset). */
export function createRepository<E extends StoredEntity>(
  executor: Executor,
  spec: TableSpec<E>,
  context: WriteContext = {},
): Repository<E> {
  return { insert: createInsert(executor, spec, context), ...createReader(executor, spec) };
}

/** Repository of a versioned entity with optimistic locking. */
export function createVersionedRepository<E extends VersionedEntity>(
  executor: Executor,
  spec: TableSpec<E>,
  context: WriteContext = {},
): VersionedRepository<E> {
  return {
    insert: createInsert(executor, spec, context),
    ...createReader(executor, spec),
    update: (entity, actor) =>
      translated(() =>
        atomic(executor, async (tx) => {
          // Lock the stored version: concurrent updates of one entity queue up here.
          const [current] = await tx<{ version: number; status: string }[]>`
            select version, status from ${tx(spec.table)} where id = ${entity.id} for update
          `;
          if (current === undefined) throw new NotFoundError(spec.entity, entity.id);
          const expectedVersion = entity.version - 1;
          if (current.version !== expectedVersion) {
            throw new ConcurrencyError(spec.entity, entity.id, expectedVersion, current.version);
          }
          const { id: _id, ...columns } = spec.toColumns(entity);
          await tx`update ${tx(spec.table)} set ${tx(columns)} where id = ${entity.id}`;
          for (const link of Object.values(spec.links)) await appendLinks(tx, link, entity);
          await appendEvent(tx, {
            id: eventIdSchema.parse(uuidv7()),
            type: entityEventType(spec.entity, 'updated'),
            aggregate: { type: spec.entity, id: entity.id },
            aggregateVersion: entity.version,
            occurredAt: entity.updatedAt,
            actor,
            correlationId: context.correlationId,
            payload: { snapshot: snapshotOf(entity), previousStatus: current.status },
          });
        }),
      ),
  };
}
