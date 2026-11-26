import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommandCenter, type CommandCenter } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';
import { ownerRouter } from '../../support/owner-router.js';

/*
 * The owner's buttons as Telegram delivers them: the full command center behind the real router
 * of the bot. The router hands a handler the data after its prefix; a handler that parses the
 * prefix again answers «устарело» to every press. Tests that call a handler directly with the
 * full data cannot see that.
 */

let test: TestDatabase;
let db: Database;
let center: CommandCenter;
const { logger } = createCapturingLogger('bot');

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  center = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
});

afterAll(async () => {
  await center.stopDigest();
  await test.drop();
});

describe('owner buttons through the router of the bot', () => {
  it('/seek records a topic after the owner confirms it', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/seek escrow for freelancers');
    expect(chat.last()?.text).toContain('🔎 Искать «escrow for freelancers»?');
    const yes = chat.buttons().find((data) => data.startsWith('sk:y:'));

    await chat.press(yes ?? expect.unreachable());
    expect(chat.last()).toMatchObject({
      edited: true,
      text: '🔎 Тема «escrow for freelancers» записана. Итог — /seek.',
    });
    expect((await db.seek.list(5)).map((topic) => topic.query)).toEqual(['escrow for freelancers']);

    // The same press again (Telegram retries a callback) changes nothing.
    await chat.press(yes ?? expect.unreachable());
    expect(chat.last()?.text).toContain('⌛ Подтверждение устарело.');
    expect(await db.seek.list(5)).toHaveLength(1);
  });

  it('/seek cancel records nothing', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/seek dental billing software');
    const cancel = chat.buttons().find((data) => data.startsWith('sk:n:'));

    await chat.press(cancel ?? expect.unreachable());
    expect(chat.last()?.text).toBe('Отменено. Ничего не записано.');
    expect((await db.seek.list(5)).map((topic) => topic.query)).not.toContain(
      'dental billing software',
    );
  });
});
