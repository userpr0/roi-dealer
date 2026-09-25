/**
 * @roi-dealer/database — PostgreSQL access for ROI Dealer (PHASE 02, ADR-0005).
 *
 * Connection pool in UTC, SQL migrations with checksums and a lock, and repositories that
 * store PHASE 01 domain entities and validate every row they read with the domain schemas.
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
  type Database,
  type DatabaseOptions,
  type TransactionScope,
} from './database.js';
export {
  ConcurrencyError,
  ConstraintViolationError,
  DataIntegrityError,
  DatabaseError,
  MigrationError,
  NotFoundError,
  translateError,
  type ConstraintKind,
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
export type { Repository, VersionedRepository } from './repository.js';

export const PACKAGE_NAME = '@roi-dealer/database';
