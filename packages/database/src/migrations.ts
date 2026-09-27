import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import type { Logger } from '@roi-dealer/observability';
import { MigrationError } from './errors.js';
import type { Sql, TransactionSql } from './executor.js';

export interface Migration {
  /** File name without `.sql`, e.g. `0001_core_domain`. */
  readonly id: string;
  /** SHA-256 of the file content (line endings normalized to LF). */
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationRunResult {
  /** Ids applied by this run, in order. */
  readonly applied: readonly string[];
  /** Migrations that were already in the database before this run. */
  readonly alreadyApplied: number;
}

const FILE_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/**
 * One lock for all migration runs of a database: concurrent runners (two deploys, a deploy
 * and a developer) wait for each other instead of applying the same migration twice.
 */
const LOCK_KEY = 'roi-dealer:schema-migrations';

/**
 * Reads `NNNN_name.sql` files in version order. Other files (README.md) are ignored;
 * a `.sql` file with another name or a repeated version number is an error.
 */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  const versions = new Set<string>();
  const migrations: Migration[] = [];
  for (const file of files) {
    const version = FILE_NAME.exec(file)?.[1];
    if (version === undefined) {
      throw new MigrationError(
        'invalid_file_name',
        `Migration file "${file}" must be named NNNN_lowercase_name.sql`,
        file,
      );
    }
    if (versions.has(version)) {
      throw new MigrationError(
        'duplicate_version',
        `Migration version ${version} is used twice`,
        file,
      );
    }
    versions.add(version);
    const sql = (await readFile(join(directory, file), 'utf8')).replace(/\r\n/g, '\n');
    migrations.push({
      id: file.slice(0, -'.sql'.length),
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }
  return migrations;
}

/** Integrity and data errors (SQLSTATE classes 22, 23) may quote row values: keep only the code. */
function describeFailure(error: unknown): string {
  if (error instanceof postgres.PostgresError) {
    const quotesValues = error.code.startsWith('22') || error.code.startsWith('23');
    return quotesValues ? `SQLSTATE ${error.code}` : `SQLSTATE ${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function lock(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
}

/**
 * Applies pending migrations, each in its own transaction.
 *
 * Stops with `MigrationError` before changing anything when the history does not match
 * the files: an applied file was edited (`checksum_mismatch`), the database has a migration
 * the code does not know (`unknown_applied_migration`), or a new file sorts before an applied
 * one (`out_of_order`).
 */
export async function runMigrations(
  sql: Sql,
  migrations: readonly Migration[],
  options: { readonly logger?: Logger } = {},
): Promise<MigrationRunResult> {
  const history = await sql.begin(async (tx) => {
    await lock(tx);
    await tx`
      create table if not exists schema_migrations (
        id           text primary key,
        checksum     text not null,
        applied_at   timestamptz(3) not null default now(),
        execution_ms integer not null
      )
    `;
    return tx<{ id: string; checksum: string }[]>`
      select id, checksum from schema_migrations order by id
    `;
  });

  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const applied of history) {
    const migration = known.get(applied.id);
    if (migration === undefined) {
      throw new MigrationError(
        'unknown_applied_migration',
        `The database has migration ${applied.id}, which this code does not contain`,
        applied.id,
      );
    }
    if (migration.checksum !== applied.checksum) {
      throw new MigrationError(
        'checksum_mismatch',
        `Migration ${applied.id} was changed after it had been applied; add a new migration instead`,
        applied.id,
      );
    }
  }

  const appliedIds = new Set(history.map((row) => row.id));
  const latestApplied = history.at(-1)?.id;
  const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
  const outOfOrder = pending.find(
    (migration) => latestApplied !== undefined && migration.id < latestApplied,
  );
  if (outOfOrder !== undefined) {
    throw new MigrationError(
      'out_of_order',
      `Migration ${outOfOrder.id} sorts before the already applied ${latestApplied ?? ''}`,
      outOfOrder.id,
    );
  }

  const applied: string[] = [];
  for (const migration of pending) {
    const startedAt = performance.now();
    const didApply = await sql
      .begin(async (tx) => {
        await lock(tx);
        // Another runner may have applied it while this one was waiting for the lock.
        const [existing] = await tx<{ checksum: string }[]>`
          select checksum from schema_migrations where id = ${migration.id}
        `;
        if (existing !== undefined) return false;
        await tx.unsafe(migration.sql).simple();
        const executionMs = Math.round(performance.now() - startedAt);
        await tx`
          insert into schema_migrations (id, checksum, execution_ms)
          values (${migration.id}, ${migration.checksum}, ${executionMs})
        `;
        return true;
      })
      .catch((error: unknown) => {
        throw error instanceof MigrationError
          ? error
          : new MigrationError(
              'failed',
              `Migration ${migration.id} failed: ${describeFailure(error)}`,
              migration.id,
            );
      });
    if (didApply) {
      applied.push(migration.id);
      options.logger?.info('migration applied', {
        migration: migration.id,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  }

  return { applied, alreadyApplied: history.length };
}
