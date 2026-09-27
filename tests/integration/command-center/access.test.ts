import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCommandCenter,
  ownerActor,
  REFUSED_THROTTLE_MS,
  requestAccess,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  createEvidence,
  createSource,
  evidenceIdSchema,
  sourceIdSchema,
  timestampMs,
  toTimestamp,
  type Actor,
  type Source,
} from '@roi-dealer/domain';
import { AGENT, at, createCtx, evidenceData, sourceData, SYSTEM } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';
import { buttons, createPanelDriver } from '../../support/panel.js';

const OWNER_TG = 1001;
const OWNER = ownerActor(OWNER_TG);

let test: TestDatabase;
let db: Database;
let center: CommandCenter;
let panel: ReturnType<typeof createPanelDriver>;
let source: Source;
let clock = timestampMs(at(60));
const now = () => toTimestamp(new Date(clock));
const { logger } = createCapturingLogger('bot');

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  center = createCommandCenter({
    database: db,
    logger,
    deliverDigest: () => Promise.resolve(),
    now: () => clock,
  });
  panel = createPanelDriver(center, logger, OWNER_TG);
  source = createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));
  await db.repositories.sources.insert(source);
});

afterAll(async () => {
  await test.drop();
});

const writeEvidence = (actor: Actor) =>
  db.repositories.evidence.insert(
    createEvidence(evidenceData(source.id), createCtx(evidenceIdSchema, actor, 1)),
  );

describe('access is granted by the owner in 📥 decisions', () => {
  it('turns an approved access_grant request into an active identity', async () => {
    const forum: Actor = { type: 'integration', id: 'forum-api' };
    const { principal, request } = await requestAccess(
      db,
      { actor: forum, displayName: 'Forum API', purpose: 'Delivers forum posts as evidence' },
      { at: now(), correlationId: 'setup-forum-api' },
    );
    expect(principal.status).toBe('pending');
    await expect(writeEvidence(forum)).rejects.toMatchObject({ code: 'permission_denied' });

    const card = (await panel.command('decisions')).find((reply) =>
      reply.text.includes('«Доступ: Forum API»'),
    );
    expect(card?.text).toContain('📥 Доступ для агента или интеграции');
    expect(card?.text).toContain('🔌 Интеграция forum-api. Delivers forum posts as evidence');

    expect((await panel.press(`ap:a:${request.id}`)).edit.text).toContain('❓ Одобрить');
    const approved = await panel.press(`ap:ya:${request.id}`);
    expect(approved.edit.text).toContain('✅ Одобрено');
    expect(approved.edit.text).toContain('🔐 Доступ выдан');

    expect(await db.repositories.principals.getById(principal.id)).toMatchObject({
      status: 'active',
    });
    const [, granted] = await db.events.history({ type: 'principal', id: principal.id });
    expect(granted).toMatchObject({ actor: OWNER, correlationId: approved.correlationId });
    await writeEvidence(forum);
  });

  it('revokes the identity when the request is rejected', async () => {
    const scraper: Actor = { type: 'agent', id: 'unwanted-agent' };
    const { principal, request } = await requestAccess(
      db,
      { actor: scraper, displayName: 'Unwanted agent', purpose: 'Should not get access' },
      { at: now() },
    );
    const rejected = await panel.press(`ap:yr:${request.id}`);
    expect(rejected.edit.text).toContain('🔐 Доступ не выдан');
    expect((await db.repositories.principals.getById(principal.id))?.status).toBe('revoked');
    await expect(writeEvidence(scraper)).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('🔐 /access', () => {
  async function agentCard() {
    const replies = await panel.command('access');
    return {
      header: replies[0]?.text ?? '',
      card: replies.find((reply) => reply.text.includes('research-agent')),
    };
  }

  it('suspends, returns and revokes an identity after a confirmation, once', async () => {
    const principal = await db.repositories.principals.getByActor(AGENT);
    if (principal === undefined) throw new Error('fixture principal missing');
    const { header, card } = await agentCard();
    expect(header).toContain('🔐 Доступы к записи в систему');
    expect(card?.text).toContain('🤖 Агент research-agent');
    expect(buttons(card)).toEqual([`pa:s:${principal.id}`, `pa:r:${principal.id}`]);

    const question = await panel.press(`pa:s:${principal.id}`);
    expect(question.edit.text).toContain('❓ Приостановить доступ?');
    expect(buttons(question.edit)).toEqual([`pa:ys:${principal.id}`, `pa:c:${principal.id}`]);
    expect(buttons((await panel.press(`pa:c:${principal.id}`)).edit)).toEqual(buttons(card));

    const suspended = await panel.press(`pa:ys:${principal.id}`, 'q-suspend');
    expect(suspended.edit.text).toContain('⏸ Доступ приостановлен');
    await expect(writeEvidence(AGENT)).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'principal_not_active' }) as unknown,
    });
    await panel.press(`pa:ys:${principal.id}`, 'q-suspend');
    const history = await db.events.history({ type: 'principal', id: principal.id });
    expect(history.at(-1)).toMatchObject({
      actor: OWNER,
      payload: { snapshot: { status: 'suspended' } },
    });
    const versions = history.length;

    expect(buttons((await panel.press(`pa:a:${principal.id}`)).edit)).toContain(
      `pa:ya:${principal.id}`,
    );
    expect((await panel.press(`pa:ya:${principal.id}`)).edit.text).toContain('▶️ Доступ возвращён');
    await writeEvidence(AGENT);

    const revoked = await panel.press(`pa:yr:${principal.id}`);
    expect(revoked.edit.text).toContain('⛔ Доступ отозван');
    expect(revoked.edit.keyboard).toBeUndefined();
    const again = await panel.press(`pa:ya:${principal.id}`);
    expect(again.edit.text).toContain('Уже изменено');
    expect(await db.events.history({ type: 'principal', id: principal.id })).toHaveLength(
      versions + 2,
    );
    await expect(writeEvidence(AGENT)).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('refuses buttons with an unknown action or id with a notice only', async () => {
    const { edits, answers } = await panel.press('pa:zz:not-an-id');
    expect(edits).toEqual([]);
    expect(answers).toEqual(['Кнопка устарела']);
  });
});

describe('access log of the command center', () => {
  it('records the owner’s views and the refused attempts, throttled per sender', async () => {
    const before = await db.access.count({ decision: 'denied' });
    await center.refused({ userId: 666, reason: 'not_owner', updateId: 1 });
    await center.refused({ userId: 666, reason: 'not_owner', updateId: 2 });
    await center.refused({ userId: 777, reason: 'not_private_chat', updateId: 3 });
    expect(await db.access.count({ decision: 'denied' })).toBe(before + 2);

    clock += REFUSED_THROTTLE_MS;
    await center.refused({ userId: 666, reason: 'not_owner', updateId: 4 });
    expect(await db.access.count({ decision: 'denied' })).toBe(before + 3);

    const [latest] = await db.access.list({ decision: 'denied', limit: 1 });
    expect(latest).toMatchObject({
      channel: 'telegram',
      actorId: 'telegram:666',
      permission: 'panel.use',
      reason: 'not_owner',
      correlationId: 'tg-update-4',
    });
    expect(latest).not.toHaveProperty('actorType');

    await panel.command('journal');
    const [view] = await db.access.list({ decision: 'allowed', limit: 1 });
    expect(view).toMatchObject({
      actorType: 'owner',
      actorId: OWNER.id,
      permission: 'journal.read',
    });
  });

  it('shows refused attempts in /access and the digest', async () => {
    const [overview] = await panel.command('access');
    expect(overview?.text).toMatch(
      /⚠️ Отклонённых попыток за 7 дней: \d+; последняя .* — telegram:666 \(not_owner\)/,
    );
    const [digest] = await panel.command('digest');
    expect(digest?.text).toMatch(/🔐 Отклонённых попыток доступа за сутки: \d+ → \/access/);
  });

  it('records /status views when asked', async () => {
    await center.statusLines({ userId: OWNER_TG, updateId: 99 });
    const [view] = await db.access.list({ decision: 'allowed', limit: 1 });
    expect(view).toMatchObject({ permission: 'status.read', correlationId: 'tg-update-99' });
  });
});
