import postgres from 'postgres';
import type { EntityType } from '@roi-dealer/domain';

/**
 * Errors of the persistence layer. Like `DomainError`, they carry stable machine-readable
 * fields and never include row values: PostgreSQL puts values into `detail` and, for data
 * exceptions, into the message — neither is copied here.
 */
export class DatabaseError extends Error {
  override readonly name: string = 'DatabaseError';
}

export class NotFoundError extends DatabaseError {
  override readonly name = 'NotFoundError';
  constructor(
    readonly entity: EntityType,
    readonly id: string,
  ) {
    super(`${entity} ${id} does not exist`);
  }
}

/** The stored version is not the one the update was based on (optimistic locking). */
export class ConcurrencyError extends DatabaseError {
  override readonly name = 'ConcurrencyError';
  constructor(
    readonly entity: EntityType,
    readonly id: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `${entity} ${id} was changed concurrently: expected version ${expectedVersion}, found ${actualVersion}`,
    );
  }
}

export type ConstraintKind =
  | 'unique'
  | 'foreign_key'
  | 'check'
  | 'not_null'
  /** Append-only history or a forbidden delete (triggers of migration 0001). */
  | 'forbidden_change'
  /** A value of the wrong type or out of range (SQLSTATE class 22). */
  | 'invalid_value'
  /** An entity row was written without its event (checked at COMMIT, migration 0002). */
  | 'missing_event'
  | 'other';

const KIND_BY_SQLSTATE: Readonly<Record<string, ConstraintKind>> = {
  '23505': 'unique',
  '23503': 'foreign_key',
  '23514': 'check',
  '23502': 'not_null',
  '23001': 'forbidden_change',
};

/** The database rejected a write: a constraint, a trigger or a value check. */
export class ConstraintViolationError extends DatabaseError {
  override readonly name = 'ConstraintViolationError';
  constructor(
    readonly kind: ConstraintKind,
    readonly sqlState: string,
    readonly constraint: string | undefined,
    readonly table: string | undefined,
  ) {
    super(
      `Database rejected the write (${kind}${constraint === undefined ? '' : `: ${constraint}`}${
        table === undefined ? '' : ` on ${table}`
      })`,
    );
  }
}

/** A stored row does not satisfy the domain schema (§2.13: never reason on corrupted data). */
export class DataIntegrityError extends DatabaseError {
  override readonly name = 'DataIntegrityError';
  constructor(
    readonly entity: EntityType | 'event',
    readonly id: string,
    readonly issues: readonly { readonly path: string; readonly message: string }[],
  ) {
    super(`Stored ${entity} ${id} does not match the domain schema`);
  }
}

export type InvalidWriteReason =
  /** History starts at version 1: store an entity when it is created, then each new version. */
  | 'insert_requires_version_1'
  | 'invalid_correlation_id'
  | 'invalid_idempotency_key'
  /** The same idempotency key was already used by a different command. */
  | 'idempotency_key_reused';

/** A write that the persistence layer refuses before touching the database (a caller bug). */
export class InvalidWriteError extends DatabaseError {
  override readonly name = 'InvalidWriteError';
  constructor(
    readonly reason: InvalidWriteReason,
    message: string,
  ) {
    super(message);
  }
}

export type MigrationErrorCode =
  | 'invalid_file_name'
  | 'duplicate_version'
  | 'checksum_mismatch'
  | 'unknown_applied_migration'
  | 'out_of_order'
  | 'failed';

export class MigrationError extends DatabaseError {
  override readonly name = 'MigrationError';
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    readonly migration?: string,
  ) {
    super(message);
  }
}

/**
 * Converts integrity (class 23) and data (class 22) errors from PostgreSQL into
 * `ConstraintViolationError`; everything else (connection, syntax…) is returned unchanged.
 */
export function translateError(error: unknown): unknown {
  if (!(error instanceof postgres.PostgresError)) return error;
  const sqlState = error.code;
  if (sqlState.startsWith('23')) {
    const missingEvent = error.constraint_name?.endsWith('_requires_event') === true;
    return new ConstraintViolationError(
      missingEvent ? 'missing_event' : (KIND_BY_SQLSTATE[sqlState] ?? 'other'),
      sqlState,
      error.constraint_name,
      error.table_name,
    );
  }
  if (sqlState.startsWith('22')) {
    return new ConstraintViolationError(
      'invalid_value',
      sqlState,
      error.constraint_name,
      error.table_name,
    );
  }
  return error;
}

/** Runs `operation` and rethrows database errors in translated form. */
export async function translated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw translateError(error);
  }
}
