/**
 * @roi-dealer/database — PostgreSQL access for ROI Dealer (PHASE 02–07, 09, 13b, ADR-0005).
 *
 * Connection pool in UTC, SQL migrations with checksums and a lock, repositories that store
 * domain entities (validating every row they read) and append an event for every
 * write (PHASE 03), Event History reads, idempotent commands, and a permission check with an
 * access log on every write (PHASE 04).
 * State still changes only through @roi-dealer/domain functions; repositories persist results.
 */
export {
  ACCESS_CHANNELS,
  createAccessLog,
  type AccessChannel,
  type AccessLog,
  type AccessLogEntry,
  type AccessLogQuery,
  type StoredAccessLogEntry,
} from './access-log.js';
export { findPrincipal, type AccessDeniedHandler } from './access.js';
export {
  AI_CALL_PURPOSES,
  AI_FAILURES,
  AI_PROVIDERS,
  createAiCallLog,
  type AiCallEntry,
  type AiCallLog,
  type AiCallPeriod,
  type AiCallPurpose,
  type AiFailure,
  type AiProvider,
  type AiSpend,
  type StoredAiCall,
} from './ai-calls.js';
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
export {
  createRepositories,
  type EvidenceRepository,
  type KnowledgeAssetRepository,
  type PrincipalRepository,
  type Repositories,
  type SourceRepository,
} from './repositories.js';
export type { ListOptions, Repository, VersionedRepository, WriteContext } from './repository.js';
export {
  createOpportunityAssessmentLog,
  OPPORTUNITY_ASSESSMENT_OUTCOMES,
  type OpportunityAssessmentEntry,
  type OpportunityAssessmentLog,
  type OpportunityAssessmentOutcome,
  type OpportunityScore,
  type ScoreComponents,
} from './opportunity-assessments.js';
export {
  createSignalExtractionLog,
  SIGNAL_EXTRACTION_OUTCOMES,
  type SignalExtractionCounts,
  type SignalExtractionEntry,
  type SignalExtractionLog,
  type SignalExtractionOutcome,
} from './signal-extractions.js';

export const PACKAGE_NAME = '@roi-dealer/database';
