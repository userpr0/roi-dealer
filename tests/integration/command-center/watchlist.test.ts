import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWatchlistFlow,
  WATCHLIST_PREFIX,
  watchlistDigestLine,
  watchlistView,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  changePainStatus,
  createEvidence,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  painIdSchema,
  signalIdSchema,
  sourceIdSchema,
  toTimestamp,
  type Pain,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';
import { ownerRouter } from '../../support/owner-router.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

let test: TestDatabase;
let db: Database;
const now = () => toTimestamp(new Date());

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
});

afterAll(async () => {
  await test.drop();
});

async function painFrom(sourceName: string, title: string, signals: number): Promise<Pain> {
  const source = createSource(sourceData({ name: sourceName }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(source);
  const evidenceIds = [];
  const signalIds = [];
  for (let index = 0; index < signals; index += 1) {
    const evidence = createEvidence(
      {
        sourceId: source.id,
        kind: 'post',
        excerpt: `${title} (${String(index)})`,
        observedAt: now(),
      },
      { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
    );
    await db.repositories.evidence.insert(evidence);
    const signal = createSignal(
      { title, summary: title, evidenceIds: [evidence.id], markets: ['US'], strength: 'moderate' },
      { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
    );
    await db.repositories.signals.insert(signal);
    evidenceIds.push(evidence.id);
    signalIds.push(signal.id);
  }
  const pain = createPain(
    {
      title,
      description: title,
      audience: 'Freelance designers',
      desiredOutcome: 'Paid on time',
      severity: 3,
      frequency: 'frequent',
      markets: ['US'],
      signalIds,
      evidenceIds,
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  return pain;
}

describe('the watchlist (phase 27)', () => {
  it('asks to return a cut pain when similar new pains grow from a new source', async () => {
    const cut = await painFrom('Forum A', 'Freelancers chase unpaid invoices every week', 1);
    await db.repositories.pains.update(
      changePainStatus(cut, 'rejected', { actor: OWNER, at: now() }),
      OWNER,
    );
    expect((await watchlistView(db)).text).toContain('Отсечённое не растёт');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const echo = await painFrom('News B', 'Freelancers chase unpaid invoices from clients', 2);
    const view = await watchlistView(db);
    expect(view.text).toContain('под наблюдением 1, снова растут 1');
    expect(view.text).toContain('«Freelancers chase unpaid invoices every week» — боль отклонена');
    expect(view.text).toContain(
      'Тогда: сигналов 1 · теперь в похожих болях: 2, новых источников 1',
    );
    expect(view.text).toContain(`Похожая новая боль: «${echo.title}»`);
    expect(await watchlistDigestLine(db)).toBe('👀 Отсечённое снова растёт: 1 → /watchlist');

    const flow = createWatchlistFlow({ database: db, now, owner: () => OWNER });
    // The buttons are pressed through the real router of the bot, as from Telegram.
    const chat = ownerRouter({
      logger: createCapturingLogger('bot').logger,
      callbacks: [{ prefix: WATCHLIST_PREFIX, handler: flow.handleButton }],
    });
    const back = (view.keyboard ?? [])
      .flat()
      .find((button) => button.callback_data.startsWith('wl:r:'));
    await chat.press(back?.callback_data ?? expect.unreachable());
    expect(chat.last()?.text).toContain('↩️ Вернуть на рассмотрение');
    const yes = chat.buttons().find((data) => data.startsWith('wl:y:'));
    await chat.press(yes ?? expect.unreachable());
    expect(chat.last()?.text).toContain('↩️ Возвращено');
    expect((await db.watchlist.decisions()).get(cut.id)).toMatchObject({
      decision: 'returned',
      echoPainId: echo.id,
      signals: 2,
    });
    expect((await watchlistView(db)).text).toContain('под наблюдением 0');
    expect(await db.watchlist.falseRejections()).toBe(0);
    await expect(db.sql`delete from watch_decisions`).rejects.toThrow();
  });
});
