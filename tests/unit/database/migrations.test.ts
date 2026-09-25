import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, MigrationError } from '@roi-dealer/database';
import { MIGRATIONS_DIR } from '../../support/database.js';

const directories: string[] = [];

async function directoryWith(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'roi-migrations-'));
  directories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(join(directory, name), content)),
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadMigrations', () => {
  it('reads SQL files in version order and ignores other files', async () => {
    const directory = await directoryWith({
      '0002_second.sql': 'select 2;',
      '0001_first.sql': 'select 1;',
      'README.md': '# notes',
    });

    const migrations = await loadMigrations(directory);

    expect(migrations.map((migration) => migration.id)).toEqual(['0001_first', '0002_second']);
    expect(migrations[0]?.sql).toBe('select 1;');
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same checksum regardless of line endings', async () => {
    const unix = await loadMigrations(
      await directoryWith({ '0001_a.sql': 'select 1;\nselect 2;\n' }),
    );
    const windows = await loadMigrations(
      await directoryWith({ '0001_a.sql': 'select 1;\r\nselect 2;\r\n' }),
    );
    expect(windows[0]?.checksum).toBe(unix[0]?.checksum);
  });

  it.each([['1_short.sql'], ['0001-dash.sql'], ['0001_Upper.sql'], ['0001_.sql']])(
    'rejects the file name %s',
    async (name) => {
      const directory = await directoryWith({ [name]: 'select 1;' });
      await expect(loadMigrations(directory)).rejects.toMatchObject({
        name: 'MigrationError',
        code: 'invalid_file_name',
      });
    },
  );

  it('rejects two files with the same version', async () => {
    const directory = await directoryWith({ '0001_a.sql': 'select 1;', '0001_b.sql': 'select 2;' });
    const error = await loadMigrations(directory).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationError);
    expect(error).toMatchObject({ code: 'duplicate_version', migration: '0001_b.sql' });
  });

  it('loads the project migrations', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect(migrations.map((migration) => migration.id)).toContain('0001_core_domain');
  });
});
