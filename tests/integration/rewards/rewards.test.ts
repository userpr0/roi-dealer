import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDigest,
  createCommandCenter,
  memberActor,
  NO_CONTRIBUTIONS_TEXT,
  type CommandCenter,
} from '@roi-dealer/command-center';
import { ConstraintViolationError, type Database } from '@roi-dealer/database';
import {
  calculateReward,
  recordRevenueEntry,
  revenueEntryIdSchema,
  rewardIdSchema,
  toTimestamp,
  usd,
  type Contribution,
  type ContributionId,
  type Experiment,
  type Reward,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import type { CallbackContext, InlineKeyboard } from '@roi-dealer/telegram';
import { approvedOpportunity, runningTest } from '../../support/cycle.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let cc: CommandCenter;
let experiment: Experiment;
const { logger, records } = createCapturingLogger('bot');
const OWNER_TG = 8181;
const OWNER_ACTOR = { type: 'owner', id: `telegram:${String(OWNER_TG)}` };
let update = 2_500;
const now = () => toTimestamp(new Date());

interface Message {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

async function run(name: string, args = ''): Promise<Message[]> {
  const replies: Message[] = [];
  const handler = cc.commands.find((item) => item.name === name)?.handler;
  if (handler === undefined) throw new Error(`no /${name}`);
  await handler({
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    args,
    logger,
    reply: (text, keyboard) => {
      replies.push({ text, keyboard });
      return Promise.resolve();
    },
  });
  return replies;
}

async function press(data: string, callbackQueryId = `q-${String((update += 1))}`) {
  const edits: Message[] = [];
  const [prefix = ''] = data.split(':');
  const handler = cc.callbacks.find((item) => item.prefix === prefix)?.handler;
  if (handler === undefined) throw new Error(`no ${prefix} buttons`);
  const context: CallbackContext = {
    chatId: OWNER_TG,
    userId: OWNER_TG,
    updateId: (update += 1),
    callbackQueryId,
    messageId: 1,
    data: data.slice(prefix.length + 1),
    logger,
    answer: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    edit: (text, keyboard) => {
      edits.push({ text, keyboard });
      return Promise.resolve();
    },
  };
  await handler(context);
  return edits.at(-1) ?? { text: '' };
}

const buttons = (message: Message | undefined) =>
  (message?.keyboard ?? []).flat().map((item) => item.callback_data);

/** Answers the confirmation of a typed command with its first button. */
async function confirm(replies: Message[]): Promise<Message> {
  const [yes] = buttons(replies.at(-1));
  if (yes === undefined) throw new Error(`no confirmation: ${replies.at(-1)?.text ?? ''}`);
  return press(yes);
}

async function contributions(): Promise<Contribution[]> {
  const all: Contribution[] = [];
  for (const status of ['recorded', 'verified', 'rejected'] as const) {
    all.push(...(await db.repositories.contributions.listByStatus(status, { limit: 100 })));
  }
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function rewards(): Promise<Reward[]> {
  const all: Reward[] = [];
  for (const status of ['calculated', 'approved', 'payable', 'paid', 'cancelled'] as const) {
    all.push(...(await db.repositories.rewards.listByStatus(status, { limit: 100 })));
  }
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Records and verifies a contribution through the bot; returns its number. */
async function verifiedContribution(args: string): Promise<number> {
  await confirm(await run('contribution', args));
  const all = await contributions();
  const added = all.at(-1);
  if (added === undefined) throw new Error('not recorded');
  await press(`ct:v:${added.id}:${String(added.version)}`);
  await press(`ct:yv:${added.id}:${String(added.version)}`);
  return all.length;
}

async function payoutRequestOf(reward: Reward) {
  const pending = await db.repositories.approvalRequests.listByStatus('pending', { limit: 100 });
  return pending.find((request) => request.subject?.id === reward.id);
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  cc = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
  const { opportunity } = await approvedOpportunity(db, 'Invoices that get paid');
  experiment = await runningTest(db, opportunity);
});

afterAll(async () => {
  await test.drop();
});

describe('a contribution from record to payout (PHASE 17, §2.10, D-006)', () => {
  it('is recorded with confirmation and verified by the owner', async () => {
    const [empty] = await run('rewards');
    expect(empty?.text).toBe(NO_CONTRIBUTIONS_TEXT);

    const replies = await run('contribution', '@Anna продажи тест 1 Привела двух клиентов');
    expect(replies.at(-1)?.text).toContain('🏆 Записать вклад?');
    expect(replies.at(-1)?.text).toContain('anna · продажи · тест №1 «Invoices that get paid»');
    expect(await contributions()).toHaveLength(0);
    const recorded = await confirm(replies);
    expect(recorded.text).toContain('Ждут проверки: 1');
    expect(recorded.text).toContain(
      '№1 · anna · продажи · тест «Invoices that get paid» — «Привела двух клиентов»',
    );
    const [stored] = await contributions();
    expect(stored).toMatchObject({
      contributor: memberActor('anna'),
      kind: 'sales',
      status: 'recorded',
      subject: { type: 'experiment', id: experiment.id },
    });
    if (stored === undefined) throw new Error('not stored');
    expect(buttons(recorded)).toEqual([`ct:v:${stored.id}:1`, `ct:x:${stored.id}:1`]);

    const asked = await press(`ct:v:${stored.id}:1`);
    expect(asked.text).toContain('❓ Подтвердить вклад?');
    const verified = await press(`ct:yv:${stored.id}:1`);
    expect(verified.text).toContain('✅ Вклад подтверждён.');
    expect(verified.text).toContain('Подтверждены, без вознаграждения: 1');
    // A stale card changes nothing.
    expect((await press(`ct:yx:${stored.id}:1`)).text).toContain('Список изменился');
    const history = await db.events.history({ type: 'contribution', id: stored.id });
    expect(history.map((event) => event.actor)).toEqual([OWNER_ACTOR, OWNER_ACTOR]);
  });

  it('is rewarded by a rule, approved in /decisions and paid as a cost of the month', async () => {
    const asked = await run('reward', '1 $50');
    expect(asked.at(-1)?.text).toContain('🏆 Начислить anna $50.00?');
    expect(asked.at(-1)?.text).toContain('Правило: фиксированная сумма.');
    const calculated = await confirm(asked);
    expect(calculated.text).toContain('🏆 Начислено.');
    const [reward] = await rewards();
    expect(reward).toMatchObject({ status: 'calculated', amount: usd(5_000), ruleId: 'fixed-v1' });
    if (reward === undefined) throw new Error('no reward');
    const request = await payoutRequestOf(reward);
    expect(request).toMatchObject({ kind: 'payout', amount: usd(5_000) });
    if (request === undefined) throw new Error('no payout request');
    expect(calculated.text).toContain('⏳ ждёт решения в /decisions');

    // Not approved yet: nothing to mark as paid.
    const [early] = await run('paid', '1 PayPal 5XY12345');
    expect(early?.text).toContain('ещё не одобрено к выплате');

    const [, card] = await run('decisions');
    expect(card?.text).toContain('Выплата');
    expect((await press(`ap:a:${request.id}`)).text).toContain('$50.00');
    const approved = await press(`ap:ya:${request.id}`);
    expect(approved.text).toContain('🏆 Выплата одобрена');
    const payable = await db.repositories.rewards.getById(reward.id);
    expect(payable).toMatchObject({ status: 'payable', approvalRequestId: request.id });

    const paidAsk = await run('paid', '1 PayPal 5XY12345');
    expect(paidAsk.at(-1)?.text).toContain('💸 Отметить выплату №1: anna $50.00?');
    const [yes] = buttons(paidAsk.at(-1));
    if (yes === undefined) throw new Error('no confirmation');
    const paid = await press(yes, 'q-paid-1');
    expect(paid.text).toContain('✅ Выплата записана');
    // The same press delivered again records nothing twice.
    await press(yes, 'q-paid-1');
    expect(await db.repositories.rewards.getById(reward.id)).toMatchObject({
      status: 'paid',
      payment: { reference: 'PayPal 5XY12345' },
    });
    const costs = await db.sql<{ category: string; amount_usd_cents: number; approval: string }[]>`
      select category, amount_usd_cents::int as amount_usd_cents,
        approval_request_id::text as approval from cost_entries
    `;
    expect(costs).toEqual([{ category: 'human', amount_usd_cents: 5_000, approval: request.id }]);
    const [economics] = await run('economics');
    expect(economics?.text).toContain('$50.00');
    const [list] = await run('rewards');
    expect(list?.text).toContain('Выплачено за месяц: $50.00 (1)');
  });
});

describe('rules, refusals and cancellations (PHASE 17)', () => {
  it('a revenue share comes from the test’s ledger; a rewarded contribution is refused', async () => {
    await db.repositories.revenueEntries.insert(
      recordRevenueEntry(
        {
          kind: 'payment',
          amount: usd(12_000),
          customers: 3,
          description: 'Owner report',
          receivedAt: now(),
          allocation: { experimentId: experiment.id },
        },
        { id: revenueEntryIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
      ),
    );
    const second = await verifiedContribution('anna контент тест 1 Написала лендинг');
    const [again] = await run('reward', '1 10%');
    expect(again?.text).toContain('⛔ Этот вклад уже входит в начисление. (вклад №1)');

    const asked = await run('reward', `${String(second)} 10%`);
    expect(asked.at(-1)?.text).toContain('🏆 Начислить anna $12.00?');
    expect(asked.at(-1)?.text).toContain('10 % от $120.00 чистой выручки теста');
    await confirm(asked);
    expect((await rewards()).at(-1)).toMatchObject({
      amount: usd(1_200),
      ruleId: 'revenue-share-v1',
      note: '10 % от $120.00 чистой выручки теста',
    });

    const bobs = await verifiedContribution('bob анализ Разобрал интервью');
    const [noTest] = await run('reward', `${String(bobs)} 10%`);
    expect(noTest?.text).toContain('каждый вклад должен быть привязан к тесту');
    const [mixed] = await run('reward', `${String(bobs)},${String(second)} $5`);
    expect(mixed?.text).toContain('Вклады разных людей начисляются отдельно');
    await confirm(await run('contribution', 'bob анализ Ещё один разбор'));
    const [unverified] = await run('reward', `${String(bobs + 1)} $5`);
    expect(unverified?.text).toContain('Вклад ещё не подтверждён');
  });

  it('a rejected payout cancels the reward; ✖️ cancels it and closes its request', async () => {
    const share = (await rewards()).at(-1);
    if (share === undefined) throw new Error('no reward');
    const request = await payoutRequestOf(share);
    if (request === undefined) throw new Error('no payout request');
    await press(`ap:r:${request.id}`);
    const rejected = await press(`ap:yr:${request.id}`);
    expect(rejected.text).toContain('🏆 Начисление отменено');
    expect((await db.repositories.rewards.getById(share.id))?.status).toBe('cancelled');

    // Its contribution is free again.
    const free = share.contributionIds[0];
    const number = (await contributions()).findIndex((item) => item.id === free) + 1;
    await confirm(await run('reward', `${String(number)} $7`));
    const fresh = (await rewards()).at(-1);
    if (fresh === undefined) throw new Error('no reward');
    const waiting = await payoutRequestOf(fresh);
    expect(waiting?.status).toBe('pending');
    const [list] = await run('rewards');
    expect(buttons(list)).toContain(`rw:k:${fresh.id}:1`);
    expect((await press(`rw:k:${fresh.id}:1`)).text).toContain('❓ Отменить начисление?');
    expect((await press(`rw:yk:${fresh.id}:1`)).text).toContain('✖️ Начисление отменено.');
    expect((await db.repositories.rewards.getById(fresh.id))?.status).toBe('cancelled');
    expect(
      (await db.repositories.approvalRequests.getById(waiting?.id ?? request.id))?.status,
    ).toBe('cancelled');
  });

  it('the digest says what waits in /rewards', async () => {
    const digest = await buildDigest(db, Date.now());
    expect(digest).toContain('🏆 Вклады ждут проверки: 1 · к выплате: 0 на $0.00 → /rewards');
    // Message texts are not logged.
    expect(JSON.stringify(records)).not.toContain('Привела двух клиентов');
  });
});

describe('the database guards §2.10 (migration 0014)', () => {
  /** A reward built past the domain, as a bug or a direct write would. */
  async function insertReward(contributor: string, ids: readonly ContributionId[]) {
    const [verified] = (await contributions()).filter((item) => item.status === 'verified');
    if (verified === undefined) throw new Error('no verified contribution');
    const valid = calculateReward(
      {
        contributor: verified.contributor,
        contributionIds: [verified.id],
        amount: usd(100),
        ruleId: 'fixed-v1',
      },
      [verified],
      { id: rewardIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
    );
    return db.repositories.rewards.insert({
      ...valid,
      contributor: memberActor(contributor),
      contributionIds: [...ids],
    });
  }

  it('refuses an unverified, foreign or already rewarded contribution', async () => {
    const all = await contributions();
    const unverified = all.find((item) => item.status === 'recorded');
    const annas = all.find(
      (item) => item.status === 'verified' && item.contributor.id === 'member:anna',
    );
    const paid = (await rewards()).find((item) => item.status === 'paid');
    if (unverified === undefined || annas === undefined || paid === undefined) {
      throw new Error('fixtures missing');
    }
    const rejection = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) =>
          error instanceof ConstraintViolationError ? error.constraint : String(error),
      );
    await expect(rejection(insertReward('bob', [unverified.id]))).resolves.toBe(
      'reward_contributions_verified',
    );
    await expect(rejection(insertReward('bob', [annas.id]))).resolves.toBe(
      'reward_contributions_same_contributor',
    );
    await expect(rejection(insertReward('anna', paid.contributionIds))).resolves.toBe(
      'reward_contributions_rewarded_once',
    );
  });
});
