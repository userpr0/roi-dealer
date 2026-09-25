import type { z } from 'zod';
import type { EntityType } from '@roi-dealer/domain';
import {
  ConcurrencyError,
  ConstraintViolationError,
  DataIntegrityError,
  NotFoundError,
  translated,
} from './errors.js';
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

/** How one domain entity maps to its table and link tables. */
export interface TableSpec<E extends { readonly id: string }> {
  readonly entity: EntityType;
  readonly table: string;
  /** Domain schema: every row read back is validated with it (§2.13). */
  readonly schema: z.ZodType<E>;
  readonly links: Readonly<Record<string, LinkSpec<E>>>;
  toColumns(entity: E): Columns;
  /** Builds the raw domain object from a row and its link lists (keyed like `links`). */
  fromRow(row: Row, links: Readonly<Record<string, readonly string[]>>): unknown;
}

export interface Repository<E extends { readonly id: string }> {
  /** Stores a new entity with its link rows in one transaction. */
  insert(entity: E): Promise<void>;
  getById(id: E['id']): Promise<E | undefined>;
  /** Returns the entities that exist, in the order of `ids`. */
  getByIds(ids: readonly E['id'][]): Promise<E[]>;
}

export interface VersionedRepository<
  E extends { readonly id: string; readonly version: number },
> extends Repository<E> {
  /**
   * Stores the next version of an entity (as returned by a domain function: `version + 1`).
   * Throws `ConcurrencyError` when the stored version is not `entity.version - 1`,
   * `NotFoundError` when the entity does not exist.
   */
  update(entity: E): Promise<void>;
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
async function appendLinks<E extends { readonly id: string }>(
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

function createReader<E extends { readonly id: string }>(
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

function createInsert<E extends { readonly id: string }>(
  executor: Executor,
  spec: TableSpec<E>,
): Repository<E>['insert'] {
  return (entity) =>
    translated(() =>
      atomic(executor, async (tx) => {
        await tx`insert into ${tx(spec.table)} ${tx(spec.toColumns(entity))}`;
        for (const link of Object.values(spec.links)) {
          await insertLinks(tx, link, entity.id, link.ids(entity), 0);
        }
      }),
    );
}

/** Repository of an append-only record (Evidence, Decision, CostEntry, KnowledgeAsset). */
export function createRepository<E extends { readonly id: string }>(
  executor: Executor,
  spec: TableSpec<E>,
): Repository<E> {
  return { insert: createInsert(executor, spec), ...createReader(executor, spec) };
}

/** Repository of a versioned entity with optimistic locking. */
export function createVersionedRepository<
  E extends { readonly id: string; readonly version: number },
>(executor: Executor, spec: TableSpec<E>): VersionedRepository<E> {
  return {
    insert: createInsert(executor, spec),
    ...createReader(executor, spec),
    update: (entity) =>
      translated(() =>
        atomic(executor, async (tx) => {
          const { id: _id, ...columns } = spec.toColumns(entity);
          const expectedVersion = entity.version - 1;
          const result = await tx`
            update ${tx(spec.table)} set ${tx(columns)}
            where id = ${entity.id} and version = ${expectedVersion}
          `;
          if (result.count === 0) {
            const [current] = await tx<{ version: number }[]>`
              select version from ${tx(spec.table)} where id = ${entity.id}
            `;
            if (current === undefined) throw new NotFoundError(spec.entity, entity.id);
            throw new ConcurrencyError(spec.entity, entity.id, expectedVersion, current.version);
          }
          for (const link of Object.values(spec.links)) await appendLinks(tx, link, entity);
        }),
      ),
  };
}
