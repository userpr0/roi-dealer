import type { Actor, Money } from '@roi-dealer/domain';
import type { Row } from './executor.js';

/*
 * Row ↔ domain conversion helpers. Reading is deliberately lenient: values are only reshaped
 * (Date → ISO string, bigint text → number) and the domain schema then validates the result,
 * so a malformed row surfaces as `DataIntegrityError` instead of a half-converted object.
 */

/** Column value accepted by the driver for our schema. */
export type ColumnValue = string | number | boolean | null | readonly string[];
export type Columns = Readonly<Record<string, ColumnValue>>;

/** timestamptz → ISO-8601 UTC string (`…Z`, milliseconds), the domain's `Timestamp`. */
export function instant(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** `*_usd_cents` (bigint arrives as text) → `Money` (D-005). */
export function money(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'number') {
    return { currency: 'USD', amountCents: Number(value) };
  }
  return value;
}

export function actor(type: unknown, id: unknown): unknown {
  return { type, id };
}

/** Drops `null` fields: optional domain fields are absent, not `null`. */
export function withoutNulls(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== null && field !== undefined),
  );
}

/** Builds an optional nested object when its marker column is not null. */
export function when(
  marker: unknown,
  build: () => Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return marker === null || marker === undefined ? undefined : withoutNulls(build());
}

export function cents(amount: Money): number {
  return amount.amountCents;
}

export function optionalCents(amount: Money | undefined): number | null {
  return amount === undefined ? null : amount.amountCents;
}

export function actorColumns(prefix: string, value: Actor): Columns {
  return { [`${prefix}_type`]: value.type, [`${prefix}_id`]: value.id };
}

interface MutableMeta {
  readonly createdAt: string;
  readonly createdBy: Actor;
  readonly updatedAt: string;
  readonly version: number;
}

interface ImmutableMeta {
  readonly createdAt: string;
  readonly createdBy: Actor;
}

export function immutableMetaColumns(entity: ImmutableMeta): Columns {
  return { created_at: entity.createdAt, ...actorColumns('created_by', entity.createdBy) };
}

export function mutableMetaColumns(entity: MutableMeta): Columns {
  return {
    ...immutableMetaColumns(entity),
    updated_at: entity.updatedAt,
    version: entity.version,
  };
}

export function readImmutableMeta(row: Row): Record<string, unknown> {
  return {
    createdAt: instant(row['created_at']),
    createdBy: actor(row['created_by_type'], row['created_by_id']),
  };
}

export function readMutableMeta(row: Row): Record<string, unknown> {
  return {
    ...readImmutableMeta(row),
    updatedAt: instant(row['updated_at']),
    version: row['version'],
  };
}
