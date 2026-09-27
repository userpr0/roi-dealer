import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  loadMigrations,
  runMigrations,
  type Database,
  type Migration,
  type Sql,
} from '@roi-dealer/database';
import {
  approvePrincipal,
  principalIdSchema,
  proposePrincipal,
  type Actor,
  type Principal,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at, MEMBER, OWNER, SYSTEM } from './domain.js';

/**
 * PostgreSQL server for integration tests: `pnpm infra:up` locally, a service container in CI.
 * Its role must be allowed to create databases (the Docker image's user is a superuser).
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL']?.trim() ||
  'postgresql://roi_dealer:roi_dealer_dev_only@localhost:5432/roi_dealer_dev';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../database/migrations', import.meta.url));

export function loadProjectMigrations(): Promise<Migration[]> {
  return loadMigrations(MIGRATIONS_DIR);
}

export interface TestDatabase {
  /** URL of the throwaway database (for child processes). */
  readonly url: string;
  readonly database: Database;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function admin<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
  const server = createDatabase({
    url: TEST_DATABASE_URL,
    applicationName: 'roi-dealer-tests-admin',
    maxConnections: 1,
  });
  try {
    return await work(server.sql);
  } catch (error) {
    throw new Error(
      'Integration tests need PostgreSQL: run `pnpm infra:up` or set TEST_DATABASE_URL',
      { cause: error },
    );
  } finally {
    await server.close();
  }
}

/**
 * Registers an active principal for `actor` the way production does: proposed by the system,
 * granted by the owner (PHASE 04).
 */
export async function registerPrincipal(database: Database, actor: Actor): Promise<Principal> {
  const proposed = proposePrincipal(
    { actor, displayName: `Test ${actor.id}`, purpose: 'Integration test fixture' },
    { id: principalIdSchema.parse(uuidv7()), actor: SYSTEM, at: at(-60) },
  );
  const active = approvePrincipal(proposed, { actor: OWNER, at: at(-59) });
  await database.repositories.principals.insert(proposed);
  await database.repositories.principals.update(active, OWNER);
  return active;
}

/** Actors of the test fixtures that need an identity to write (tests/support/domain.ts). */
export const FIXTURE_PRINCIPALS: readonly Actor[] = [AGENT, MEMBER];

/**
 * Creates an empty database with a unique name, so test files can run in parallel
 * and every file starts from a clean schema. Migrations are applied and the fixture actors
 * registered unless `migrate: false`.
 */
export async function createTestDatabase(
  options: { readonly migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `roi_test_${randomUUID().replaceAll('-', '')}`;
  await admin((sql) => sql`create database ${sql(name)}`);
  const url = withDatabaseName(TEST_DATABASE_URL, name);
  const database = createDatabase({ url, applicationName: 'roi-dealer-tests', maxConnections: 4 });
  if (options.migrate ?? true) {
    await runMigrations(database.sql, await loadProjectMigrations());
    for (const actor of FIXTURE_PRINCIPALS) await registerPrincipal(database, actor);
  }
  return {
    url,
    database,
    async drop() {
      await database.close();
      await admin((sql) => sql`drop database if exists ${sql(name)} with (force)`);
    },
  };
}
