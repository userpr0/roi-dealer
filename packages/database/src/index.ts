/**
 * @roi-dealer/database — PostgreSQL access for ROI Dealer (PHASE 02–03, ADR-0005).
 *
 * Connection pool in UTC, SQL migrations with checksums and a lock, repositories that store
 * PHASE 01 domain entities (validating every row they read) and append an event for every
 * write (PHASE 03), Event History reads and idempotent commands.
 * State still changes only through @roi-dealer/domain functions; repositories persist results.
 */
export {
  databaseConfigSchema,
  databaseConfigShape,
  databaseUrlSchema,
  loadDatabaseConfig,
  type DatabaseConfig,
} from './config.js';
export {
  createDatabase,
  createDatabaseHealthCheck,
  type CommandOptions,
  type CommandResult,
  type Database,
  type DatabaseOptions,
  type TransactionOptions,
  type TransactionScope,
} from './database.js';
export { createEventStore, type EventQuery, type EventStore } from './event-store.js';
export {
  ConcurrencyError,
  ConstraintViolationError,
  DataIntegrityError,
  DatabaseError,
  InvalidWriteError,
  MigrationError,
  NotFoundError,
  translateError,
  type ConstraintKind,
  type InvalidWriteReason,
  type MigrationErrorCode,
} from './errors.js';
export type { Executor, Sql, TransactionSql } from './executor.js';
export {
  loadMigrations,
  runMigrations,
  type Migration,
  type MigrationRunResult,
} from './migrations.js';
export { createRepositories, type Repositories } from './repositories.js';
export type { Repository, VersionedRepository, WriteContext } from './repository.js';

export const PACKAGE_NAME = '@roi-dealer/database';
