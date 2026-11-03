import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { startService } from '../../support/service-process.js';

const ENTRY = 'packages/database/src/backup-mark-cli.ts';

let test: TestDatabase;

beforeAll(async () => {
  test = await createTestDatabase();
});

afterAll(async () => {
  await test.drop();
});

describe('the backup mark (0020)', () => {
  it('records one mark of the backup with whether the reserve got its copy', async () => {
    const run = startService(ENTRY, {
      DATABASE_URL: test.url,
      APP_VERSION: 'abc1234',
      BACKUP_RESERVE: '1',
    });
    expect(await run.waitForExit(30_000)).toMatchObject({ code: 0 });
    expect(run.logs.some((line) => line['message'] === 'backup marked')).toBe(true);

    const [backup] = (await test.database.services.heartbeats()).filter(
      (row) => row.service === 'backup',
    );
    expect(backup).toMatchObject({ version: 'abc1234', setup: { reserve: true } });
  });

  it('fails without a database address', async () => {
    const run = startService(ENTRY, { BACKUP_RESERVE: '0' });
    expect(await run.waitForExit(30_000)).toMatchObject({ code: 1 });
  });

  it('accepts only the known services', async () => {
    await expect(
      test.database.sql`insert into service_heartbeats (service, version, started_at, seen_at)
        values ('cron', 'abc1234', now(), now())`,
    ).rejects.toThrow(/service_heartbeats_service_check/);
  });
});
