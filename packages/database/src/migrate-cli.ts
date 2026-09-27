/**
 * `pnpm db:migrate` — applies pending SQL migrations to `DATABASE_URL`.
 * Exit code 0: the schema is up to date; 1: configuration or migration error (logged as JSON).
 */
import { resolve } from 'node:path';
import { z } from 'zod';
import { createLogger, LOG_LEVELS } from '@roi-dealer/observability';
import { exitProcess, loadConfig } from '@roi-dealer/shared';
import { databaseConfigShape } from './config.js';
import { createDatabase } from './database.js';
import { loadMigrations, runMigrations } from './migrations.js';

const SERVICE = 'db-migrate';

const migrateConfigSchema = z.object({
  ...databaseConfigShape,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Relative to the working directory (the repository root for `pnpm db:migrate`). */
  DATABASE_MIGRATIONS_DIR: z.string().min(1).default('database/migrations'),
});

async function main(): Promise<void> {
  const config = loadConfig(migrateConfigSchema, process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });
  const database = createDatabase({
    url: config.DATABASE_URL,
    applicationName: 'roi-dealer-migrate',
    maxConnections: 1,
    connectTimeoutSeconds: config.DATABASE_CONNECT_TIMEOUT_SECONDS,
    logger,
  });
  try {
    const migrations = await loadMigrations(resolve(config.DATABASE_MIGRATIONS_DIR));
    const result = await runMigrations(database.sql, migrations, { logger });
    logger.info('database schema is up to date', {
      applied: result.applied,
      already_applied: result.alreadyApplied,
    });
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('migration run failed', { error });
  exitProcess(1);
});
