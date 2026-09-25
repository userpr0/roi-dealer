import { afterEach, describe, expect, it } from 'vitest';
import { MigrationError, runMigrations, type Migration } from '@roi-dealer/database';
import { createCapturingLogger } from '../../support/logger.js';
import {
  createTestDatabase,
  loadProjectMigrations,
  type TestDatabase,
} from '../../support/database.js';

const testDatabases: TestDatabase[] = [];

async function freshDatabase(): Promise<TestDatabase> {
  const created = await createTestDatabase({ migrate: false });
  testDatabases.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(testDatabases.splice(0).map((item) => item.drop()));
});

const migration = (id: string, sql: string): Migration => ({ id, sql, checksum: `checksum-${id}` });

async function appliedIds(test: TestDatabase): Promise<string[]> {
  const rows = await test.database.sql<{ id: string }[]>`
    select id from schema_migrations order by id
  `;
  return rows.map((row) => row.id);
}

async function tableExists(test: TestDatabase, name: string): Promise<boolean> {
  const [row] = await test.database.sql<{ exists: boolean }[]>`
    select to_regclass(${name}) is not null as exists
  `;
  return row?.exists ?? false;
}

describe('runMigrations with the project migrations', () => {
  it('builds the schema on an empty database and records a checksum', async () => {
    const test = await freshDatabase();
    const migrations = await loadProjectMigrations();
    const { logger, records } = createCapturingLogger();

    const result = await runMigrations(test.database.sql, migrations, { logger });

    expect(result).toEqual({
      applied: ['0001_core_domain', '0002_event_history'],
      alreadyApplied: 0,
    });
    expect(await tableExists(test, 'public.opportunities')).toBe(true);
    const [row] = await test.database.sql<{ checksum: string }[]>`
      select checksum from schema_migrations where id = '0001_core_domain'
    `;
    expect(row?.checksum).toBe(migrations[0]?.checksum);
    expect(records.map((record) => record['message'])).toContain('migration applied');
  });

  it('does nothing on the second run', async () => {
    const test = await freshDatabase();
    const migrations = await loadProjectMigrations();
    await runMigrations(test.database.sql, migrations);

    await expect(runMigrations(test.database.sql, migrations)).resolves.toEqual({
      applied: [],
      alreadyApplied: 2,
    });
  });

  it('applies each migration once when two runners start at the same time', async () => {
    const test = await freshDatabase();
    const migrations = await loadProjectMigrations();

    const results = await Promise.all([
      runMigrations(test.database.sql, migrations),
      runMigrations(test.database.sql, migrations),
    ]);

    expect(results.flatMap((result) => result.applied)).toEqual([
      '0001_core_domain',
      '0002_event_history',
    ]);
    expect(await appliedIds(test)).toEqual(['0001_core_domain', '0002_event_history']);
  });
});

describe('runMigrations safety checks', () => {
  it('refuses to continue when an applied migration was edited', async () => {
    const test = await freshDatabase();
    await runMigrations(test.database.sql, [migration('0001_a', 'create table a (id int)')]);

    const edited = { ...migration('0001_a', 'create table a (id bigint)'), checksum: 'other' };
    await expect(runMigrations(test.database.sql, [edited])).rejects.toMatchObject({
      name: 'MigrationError',
      code: 'checksum_mismatch',
      migration: '0001_a',
    });
  });

  it('refuses to run code that does not know a migration applied to the database', async () => {
    const test = await freshDatabase();
    await runMigrations(test.database.sql, [
      migration('0001_a', 'create table a (id int)'),
      migration('0002_b', 'create table b (id int)'),
    ]);

    await expect(
      runMigrations(test.database.sql, [migration('0001_a', 'create table a (id int)')]),
    ).rejects.toMatchObject({ code: 'unknown_applied_migration', migration: '0002_b' });
  });

  it('refuses a new migration that sorts before an applied one', async () => {
    const test = await freshDatabase();
    const first = migration('0001_a', 'create table a (id int)');
    const third = migration('0003_c', 'create table c (id int)');
    await runMigrations(test.database.sql, [first, third]);

    await expect(
      runMigrations(test.database.sql, [first, migration('0002_b', 'select 1'), third]),
    ).rejects.toMatchObject({ code: 'out_of_order', migration: '0002_b' });
    expect(await appliedIds(test)).toEqual(['0001_a', '0003_c']);
  });

  it('rolls back a failed migration completely and keeps the earlier ones', async () => {
    const test = await freshDatabase();

    const failure = await runMigrations(test.database.sql, [
      migration('0001_a', 'create table a (id int)'),
      migration('0002_b', 'create table b (id int); select 1 / 0'),
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({ code: 'failed', migration: '0002_b' });
    expect((failure as Error).message).toContain('SQLSTATE 22012');
    expect(await appliedIds(test)).toEqual(['0001_a']);
    expect(await tableExists(test, 'public.a')).toBe(true);
    expect(await tableExists(test, 'public.b')).toBe(false);
  });
});

describe('database sessions', () => {
  it('run in UTC', async () => {
    const test = await freshDatabase();
    const [row] = await test.database.sql<{ timezone: string }[]>`
      select current_setting('TimeZone') as timezone
    `;
    expect(row?.timezone).toBe('UTC');
  });
});
