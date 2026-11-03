/**
 * Marks one successful nightly backup (D-029, migration 0020): `infra/hetzner/backup.sh` runs
 * it after the dump and its copy into the reserve database. The bot's watchdog reports when no
 * backup has succeeded for 26 hours. Exit code 0: marked; 1: configuration or database error.
 */
import { z } from 'zod';
import { createLogger, LOG_LEVELS } from '@roi-dealer/observability';
import { exitProcess, loadConfig } from '@roi-dealer/shared';
import { databaseConfigShape } from './config.js';
import { createDatabase } from './database.js';
import { createServiceHeartbeat } from './services.js';

const SERVICE = 'db-backup-mark';

const backupMarkConfigSchema = z.object({
  ...databaseConfigShape,
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  APP_VERSION: z.string().min(1).max(64).default('dev'),
  /** `1` when the dump was also restored into the reserve database. */
  BACKUP_RESERVE: z.enum(['0', '1']).default('0'),
});

async function main(): Promise<void> {
  const config = loadConfig(backupMarkConfigSchema, process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });
  const database = createDatabase({
    url: config.DATABASE_URL,
    applicationName: 'roi-dealer-backup-mark',
    maxConnections: 1,
    connectTimeoutSeconds: config.DATABASE_CONNECT_TIMEOUT_SECONDS,
    logger,
  });
  try {
    let failed = false;
    const mark = createServiceHeartbeat({
      watch: {
        beat: (heartbeat) =>
          database.services.beat(heartbeat).catch((error: unknown) => {
            failed = true;
            throw error;
          }),
      },
      service: 'backup',
      version: config.APP_VERSION,
      setup: { reserve: config.BACKUP_RESERVE === '1' },
      logger,
    });
    mark.start();
    await mark.stop();
    if (failed) throw new Error('the backup mark was not recorded');
    logger.info('backup marked', { reserve: config.BACKUP_RESERVE === '1' });
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  createLogger({ service: SERVICE }).fatal('backup mark failed', { error });
  exitProcess(1);
});
