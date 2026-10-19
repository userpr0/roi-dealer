import { randomBytes } from 'node:crypto';
import {
  approvalRequestIdSchema,
  approveReward,
  calculateReward,
  cancelApprovalRequest,
  cancelReward,
  contributionIdSchema,
  costEntryIdSchema,
  createApprovalRequest,
  createContribution,
  experimentIdSchema,
  formatUsd,
  isApprovalExpired,
  markRewardPayable,
  recordRewardPayout,
  rewardIdSchema,
  reviewContribution,
  startOfUtcMonth,
  timestampMs,
  toTimestamp,
  usd,
  type Actor,
  type ApprovalRequest,
  type Contribution,
  type ContributionId,
  type Money,
  type Reward,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database, type Repositories } from '@roi-dealer/database';
import {
  contributionsTest,
  MAX_FIXED_REWARD,
  MAX_REVENUE_SHARE_PERCENT,
  planReward,
  REWARD_RULES,
  type RewardPlan,
  type RewardRefusal,
  type RewardTerms,
} from '@roi-dealer/rewards';
import { uuidv7 } from '@roi-dealer/shared';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboard,
} from '@roi-dealer/telegram';
import { activeExperimentViews } from './experiments.js';
import { formatTime, shorten } from './texts.js';

/*
 * Rewards in the panel (PHASE 17, §2.10): /contribution records what a team member did, the
 * owner verifies it in /rewards, /reward calculates the amount by a rule and requests the payout
 * in /decisions (D-006), and /paid records the payout the owner made — as a cost of the month.
 * Every write asks for confirmation first and is one idempotent owner command.
 */

/** Buttons of contributions: `ct:<v|yv|x|yx|c>:<id>:<version>`, /contribution `ct:<y|n>:<nonce>`. */
export const CONTRIBUTION_PREFIX = 'ct';
/** Buttons of rewards: `rw:<k|yk|c>:<id>:<version>`, /reward and /paid `rw:<y|n>:<nonce>`. */
export const REWARD_PREFIX = 'rw';
/** A payout request waits this long in /decisions. */
export const PAYOUT_REQUEST_DAYS = 7;
const SHOWN = 10;
const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const DAY_MS = 86_400_000;

type ContributionKind = Contribution['kind'];

export const CONTRIBUTION_KIND_LABELS: Readonly<Record<ContributionKind, string>> = {
  research: 'исследование',
  evidence: 'доказательства',
  analysis: 'анализ',
  build: 'разработка',
  content: 'контент',
  sales: 'продажи',
  operations: 'операции',
  other: 'другое',
};

const KIND_WORDS: Readonly<Record<string, ContributionKind>> = Object.fromEntries(
  Object.entries(CONTRIBUTION_KIND_LABELS).flatMap(([kind, label]) => [
    [label, kind as ContributionKind],
    [kind, kind as ContributionKind],
  ]),
);

const RULE_LABELS: Readonly<Record<string, string>> = {
  [REWARD_RULES.fixed]: 'фиксированная сумма',
  [REWARD_RULES.revenue_share]: 'доля чистой выручки теста',
};

const REFUSALS: Readonly<Record<RewardRefusal, string>> = {
  empty: 'Укажите номера вкладов.',
  not_a_member: 'Вознаграждение — только участникам команды.',
  not_verified: 'Вклад ещё не подтверждён: ✅ в /rewards.',
  other_contributor: 'Вклады разных людей начисляются отдельно.',
  already_rewarded: 'Этот вклад уже входит в начисление.',
  bad_amount: `Сумма — от $0.01 до ${formatUsd(MAX_FIXED_REWARD)}.`,
  bad_percent: `Доля — от 0 до ${String(MAX_REVENUE_SHARE_PERCENT)} %.`,
  no_test: 'Для доли выручки каждый вклад должен быть привязан к тесту («тест N» в /contribution).',
  different_tests: 'Для доли выручки вклады должны относиться к одному тесту.',
  no_revenue: 'У теста ещё нет подтверждённой выручки (оплаты минус возвраты).',
};

export interface RewardFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

// ---------------------------------------------------------------- Numbering and texts

/** People are stored as members with a short handle; no personal data (PHASE 17). */
export function memberActor(handle: string): Actor {
  return { type: 'member', id: `member:${handle}` };
}

function handleOf(actor: Actor): string {
  return actor.id.replace(/^member:/, '');
}

const byCreation = <T extends { readonly createdAt: string; readonly id: string }>(
  a: T,
  b: T,
): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** All contributions in order of creation: their number is their position (never changes). */
async function numberedContributions(repositories: Repositories): Promise<Contribution[]> {
  const all: Contribution[] = [];
  for (const status of ['recorded', 'verified', 'rejected'] as const) {
    all.push(...(await repositories.contributions.listByStatus(status, { limit: 1_000 })));
  }
  return all.sort(byCreation);
}

/** All rewards in order of creation, numbered the same way. */
async function numberedRewards(repositories: Repositories): Promise<Reward[]> {
  const all: Reward[] = [];
  for (const status of ['calculated', 'approved', 'payable', 'paid', 'cancelled'] as const) {
    all.push(...(await repositories.rewards.listByStatus(status, { limit: 1_000 })));
  }
  return all.sort(byCreation);
}

/** Contributions in a reward that is not cancelled. */
function rewardedContributions(rewards: readonly Reward[]): Set<ContributionId> {
  return new Set(
    rewards.filter((item) => item.status !== 'cancelled').flatMap((item) => item.contributionIds),
  );
}

/** The pending payout request of each calculated reward. */
async function payoutRequests(repositories: Repositories): Promise<Map<string, ApprovalRequest>> {
  const pending = await repositories.approvalRequests.listByStatus('pending', { limit: 1_000 });
  return new Map(
    pending
      .filter((request) => request.kind === 'payout' && request.subject?.type === 'reward')
      .map((request) => [request.subject?.id ?? '', request]),
  );
}

async function testTitle(repositories: Repositories, contribution: Contribution): Promise<string> {
  const id = experimentIdSchema.safeParse(
    contribution.subject?.type === 'experiment' ? contribution.subject.id : undefined,
  );
  if (!id.success) return '';
  const experiment = await repositories.experiments.getById(id.data);
  const opportunity =
    experiment === undefined
      ? undefined
      : await repositories.opportunities.getById(experiment.opportunityId);
  return opportunity === undefined ? ' · тест' : ` · тест «${shorten(opportunity.title, 60)}»`;
}

async function contributionLine(
  repositories: Repositories,
  contribution: Contribution,
  number: number,
): Promise<string> {
  return (
    `№${String(number)} · ${handleOf(contribution.contributor)} · ${CONTRIBUTION_KIND_LABELS[contribution.kind]}` +
    `${await testTitle(repositories, contribution)} — «${shorten(contribution.description, 160)}»`
  );
}

function rewardState(
  reward: Reward,
  number: number,
  request: ApprovalRequest | undefined,
  at: Timestamp,
): string {
  switch (reward.status) {
    case 'calculated':
      return request !== undefined && !isApprovalExpired(request, at)
        ? `⏳ ждёт решения в /decisions до ${formatTime(request.expiresAt)}`
        : '⌛ запрос выплаты истёк — отмените ✖️ и начислите заново';
    case 'approved':
    case 'payable':
      return `💸 к выплате — переведите и отметьте: /paid ${String(number)} <ссылка на перевод>`;
    case 'paid':
      return `✅ выплачено ${reward.payment === undefined ? '' : formatTime(reward.payment.paidAt)}`;
    case 'cancelled':
      return '✖️ отменено';
  }
}

function rewardLine(
  reward: Reward,
  number: number,
  numbers: ReadonlyMap<string, number>,
  request: ApprovalRequest | undefined,
  at: Timestamp,
): string {
  const contributions = reward.contributionIds
    .map((id) => `№${String(numbers.get(id) ?? '?')}`)
    .join(', ');
  return [
    `№${String(number)} · ${handleOf(reward.contributor)} · ${formatUsd(reward.amount)} · ` +
      `${RULE_LABELS[reward.ruleId] ?? reward.ruleId}${reward.note === undefined ? '' : ` (${reward.note})`} · вклады ${contributions}`,
    `   ${rewardState(reward, number, request, at)}`,
  ].join('\n');
}

function contributionButton(text: string, action: string, contribution: Contribution) {
  return callbackButton(
    text,
    `${CONTRIBUTION_PREFIX}:${action}:${contribution.id}:${String(contribution.version)}`,
  );
}

function rewardButton(text: string, action: string, reward: Reward) {
  return callbackButton(text, `${REWARD_PREFIX}:${action}:${reward.id}:${String(reward.version)}`);
}

export const NO_CONTRIBUTIONS_TEXT =
  '🏆 Вкладов пока нет.\n\nКогда кто-то поможет циклу — привёл клиента, провёл интервью, ' +
  'собрал лендинг, — запишите: /contribution <кто> <вид> [тест N] <что сделано>\n' +
  'Например: /contribution anna продажи тест 1 Привела двух клиентов';

/** /rewards: what waits for the owner — verification, a reward, a payout — and the month's payouts. */
export async function rewardsReply(
  database: Database,
  nowMs: number,
): Promise<{ readonly text: string; readonly keyboard?: InlineKeyboard | undefined }> {
  const { repositories } = database;
  const at = toTimestamp(new Date(nowMs));
  const [contributions, rewards, requests] = await Promise.all([
    numberedContributions(repositories),
    numberedRewards(repositories),
    payoutRequests(repositories),
  ]);
  if (contributions.length === 0) return { text: NO_CONTRIBUTIONS_TEXT };
  const numbers = new Map(contributions.map((item, index) => [item.id, index + 1]));
  const rewardNumbers = new Map(rewards.map((item, index) => [item.id, index + 1]));
  const rewarded = rewardedContributions(rewards);
  const lines = ['🏆 Вклады и вознаграждения'];
  const rows: InlineKeyboard[number][] = [];

  const recorded = contributions.filter((item) => item.status === 'recorded');
  if (recorded.length > 0) {
    lines.push('', `Ждут проверки: ${String(recorded.length)}`);
    for (const contribution of recorded.slice(0, SHOWN)) {
      const number = numbers.get(contribution.id) ?? 0;
      lines.push(await contributionLine(repositories, contribution, number));
      rows.push([
        contributionButton(`✅ №${String(number)}`, 'v', contribution),
        contributionButton(`❌ №${String(number)}`, 'x', contribution),
      ]);
    }
  }

  const free = contributions.filter((item) => item.status === 'verified' && !rewarded.has(item.id));
  if (free.length > 0) {
    lines.push('', `Подтверждены, без вознаграждения: ${String(free.length)}`);
    for (const contribution of free.slice(0, SHOWN)) {
      lines.push(
        await contributionLine(repositories, contribution, numbers.get(contribution.id) ?? 0),
      );
    }
    lines.push('Начислить: /reward <номера> $сумма или /reward <номера> N% (доля выручки теста)');
  }

  const open = rewards.filter((item) =>
    ['calculated', 'approved', 'payable'].includes(item.status),
  );
  if (open.length > 0) {
    lines.push('', `Начисления: ${String(open.length)}`);
    for (const reward of open.slice(0, SHOWN)) {
      const number = rewardNumbers.get(reward.id) ?? 0;
      lines.push(rewardLine(reward, number, numbers, requests.get(reward.id), at));
      rows.push([rewardButton(`✖️ Отменить №${String(number)}`, 'k', reward)]);
    }
  }

  const monthStart = startOfUtcMonth(nowMs);
  const paid = rewards.filter(
    (item) =>
      item.status === 'paid' &&
      item.payment !== undefined &&
      timestampMs(item.payment.paidAt) >= monthStart,
  );
  const paidTotal = usd(paid.reduce((sum, item) => sum + item.amount.amountCents, 0));
  lines.push(
    '',
    `Выплачено за месяц: ${formatUsd(paidTotal)} (${String(paid.length)}) — расходы «Люди» в /economics.`,
    'Источник: таблицы БД.',
  );
  return { text: lines.join('\n'), ...(rows.length === 0 ? {} : { keyboard: rows }) };
}

/** The digest's line (PHASE 17): what waits for the owner in /rewards. */
export async function rewardsDigestLine(repositories: Repositories): Promise<string | undefined> {
  const [recorded, payable, approved] = await Promise.all([
    repositories.contributions.listByStatus('recorded', { limit: 1_000 }),
    repositories.rewards.listByStatus('payable', { limit: 1_000 }),
    repositories.rewards.listByStatus('approved', { limit: 1_000 }),
  ]);
  const toPay = [...payable, ...approved];
  if (recorded.length === 0 && toPay.length === 0) return undefined;
  const total = usd(toPay.reduce((sum, item) => sum + item.amount.amountCents, 0));
  return (
    `🏆 Вклады ждут проверки: ${String(recorded.length)} · к выплате: ${String(toPay.length)} ` +
    `на ${formatUsd(total)} → /rewards`
  );
}

// ---------------------------------------------------------------- Parsing

export interface ContributionInput {
  readonly handle: string;
  readonly kind: ContributionKind;
  /** The number in /experiments. */
  readonly test?: number | undefined;
  readonly description: string;
}

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const CONTRIBUTION_USAGE =
  'Формат: /contribution <кто> <вид> [тест N] <что сделано>\n' +
  `Вид: ${Object.values(CONTRIBUTION_KIND_LABELS).join(', ')}.\n` +
  'Например: /contribution anna продажи тест 1 Привела двух клиентов';

/** `/contribution anna продажи тест 1 Привела двух клиентов`. */
export function parseContribution(args: string): ContributionInput | string {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  const [rawHandle, rawKind] = tokens;
  if (rawHandle === undefined || rawKind === undefined) return CONTRIBUTION_USAGE;
  const handle = rawHandle.replace(/^@/, '').toLowerCase();
  if (!HANDLE.test(handle)) {
    return `Кто — короткое имя латиницей: буквы, цифры, «-», «_», до 32 символов (например, anna).\n\n${CONTRIBUTION_USAGE}`;
  }
  const kind = KIND_WORDS[rawKind.toLowerCase()];
  if (kind === undefined)
    return `Неизвестный вид «${shorten(rawKind, 30)}».\n\n${CONTRIBUTION_USAGE}`;
  let rest = tokens.slice(2);
  let test: number | undefined;
  if (['тест', 'test'].includes(rest[0]?.toLowerCase() ?? '')) {
    test = Number(rest[1]?.replace(/^№/, ''));
    if (!Number.isSafeInteger(test) || test <= 0)
      return `Номер теста — из /experiments.\n\n${CONTRIBUTION_USAGE}`;
    rest = rest.slice(2);
  }
  const description = rest.join(' ');
  if (description.length < 3) return `Опишите, что сделано.\n\n${CONTRIBUTION_USAGE}`;
  if (description.length > 2_000) return 'Описание — до 2000 символов.';
  return { handle, kind, ...(test === undefined ? {} : { test }), description };
}

export interface RewardInput {
  readonly numbers: readonly number[];
  readonly terms: RewardTerms;
}

export const REWARD_USAGE =
  'Формат: /reward <номера вкладов> <сумма>\n' +
  '• /reward 3 $50 — фиксированная сумма\n' +
  `• /reward 3,4 10% — доля чистой выручки теста (до ${String(MAX_REVENUE_SHARE_PERCENT)} %)\n` +
  'Номера — из /rewards.';

/** `/reward 3,4 $50` or `/reward 3 10%`. */
export function parseRewardCommand(args: string): RewardInput | string {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length < 2) return REWARD_USAGE;
  const rawTerms = tokens.at(-1) ?? '';
  const numbers = tokens
    .slice(0, -1)
    .join(',')
    .split(',')
    .filter((item) => item !== '')
    .map((item) => Number(item.replace(/^№/, '')));
  if (numbers.length === 0 || numbers.some((item) => !Number.isSafeInteger(item) || item <= 0)) {
    return REWARD_USAGE;
  }
  if (new Set(numbers).size !== numbers.length || numbers.length > 100) return REWARD_USAGE;
  const share = /^(\d{1,2}(?:[.,]\d{1,2})?)%$/.exec(rawTerms);
  if (share !== null) {
    return {
      numbers,
      terms: { rule: 'revenue_share', percent: Number(share[1]?.replace(',', '.')) },
    };
  }
  const fixed = /^\$?(\d{1,7}(?:[.,]\d{1,2})?)\$?$/.exec(rawTerms);
  if (fixed === null) return REWARD_USAGE;
  const cents = Math.round(Number(fixed[1]?.replace(',', '.')) * 100);
  return { numbers, terms: { rule: 'fixed', amount: usd(cents) } };
}

export interface PaidInput {
  readonly number: number;
  readonly reference: string;
}

export const PAID_USAGE =
  'Формат: /paid <номер начисления> <ссылка на перевод>\nНапример: /paid 2 PayPal 5XY12345';

/** `/paid 2 PayPal 5XY12345`. */
export function parsePaid(args: string): PaidInput | string {
  const [rawNumber, ...rest] = args
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  const number = Number(rawNumber?.replace(/^№/, ''));
  if (!Number.isSafeInteger(number) || number <= 0) return PAID_USAGE;
  const reference = rest.join(' ');
  if (reference.length < 3) return `Укажите ссылку или номер перевода.\n\n${PAID_USAGE}`;
  if (reference.length > 200) return 'Ссылка — до 200 символов.';
  return { number, reference };
}

// ---------------------------------------------------------------- Flows

type Pending =
  | { readonly kind: 'contribution'; readonly input: ContributionInput; readonly testId?: string }
  | {
      readonly kind: 'reward';
      readonly contributionIds: readonly ContributionId[];
      readonly terms: RewardTerms;
      readonly amount: Money;
    }
  | { readonly kind: 'paid'; readonly rewardId: string; readonly reference: string };

export interface RewardFlow {
  readonly rewards: (context: CommandContext) => Promise<void>;
  readonly contribution: (context: CommandContext) => Promise<void>;
  readonly reward: (context: CommandContext) => Promise<void>;
  readonly paid: (context: CommandContext) => Promise<void>;
  readonly handleContributionButton: (context: CallbackContext) => Promise<void>;
  readonly handleRewardButton: (context: CallbackContext) => Promise<void>;
}

const STALE_TEXT = '⚠️ Список изменился — вот текущий.';

/** The terms as the owner reads them in a confirmation. */
function termsText(terms: RewardTerms, base: Money | undefined): string {
  return terms.rule === 'fixed'
    ? (RULE_LABELS[REWARD_RULES.fixed] ?? '')
    : `${String(terms.percent)} % от ${formatUsd(base ?? usd(0))} чистой выручки теста`;
}

/** The plan of a reward from the database as it is now (inside or outside a command). */
async function planFrom(
  scope: Pick<Database, 'repositories' | 'economics'>,
  contributionIds: readonly ContributionId[],
  terms: RewardTerms,
): Promise<{ readonly plan: RewardPlan; readonly contributions: Contribution[] }> {
  const contributions = (await scope.repositories.contributions.getByIds(contributionIds)).filter(
    (item) => contributionIds.includes(item.id),
  );
  const rewarded = rewardedContributions(await numberedRewards(scope.repositories));
  const test = contributionsTest(contributions);
  const revenue =
    terms.rule === 'revenue_share' && test !== 'none' && test !== 'different'
      ? (await scope.economics.moneyFlows([test])).get(test)
      : undefined;
  return { plan: planReward({ contributions, rewarded, terms, revenue }), contributions };
}

export function createRewardFlow(deps: RewardFlowDeps): RewardFlow {
  const pending = new Map<string, Pending & { readonly expiresAtMs: number }>();
  const nowMs = (): number => timestampMs(deps.now());
  const { database } = deps;

  function remember(entry: Pending): string {
    const current = nowMs();
    for (const [nonce, item] of pending) {
      if (item.expiresAtMs <= current) pending.delete(nonce);
    }
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const nonce = randomBytes(8).toString('hex');
    pending.set(nonce, { ...entry, expiresAtMs: current + CONFIRMATION_TTL_MS });
    return nonce;
  }

  function confirmKeyboard(prefix: string, nonce: string, yes: string): InlineKeyboard {
    return [
      [
        callbackButton(yes, `${prefix}:y:${nonce}`),
        callbackButton('Отмена', `${prefix}:n:${nonce}`),
      ],
    ];
  }

  async function list(context: CallbackContext, note?: string): Promise<void> {
    const reply = await rewardsReply(database, nowMs());
    await context.edit(
      note === undefined ? reply.text : `${reply.text}\n\n${note}`,
      reply.keyboard,
    );
  }

  /** Takes a confirmation of a typed command, or says it is gone. */
  async function confirmation(
    context: CallbackContext,
    kind: Pending['kind'],
  ): Promise<{ readonly entry: Pending; readonly nonce: string } | undefined> {
    const [answer, nonce] = context.data.split(':');
    const entry = nonce === undefined ? undefined : pending.get(nonce);
    if (answer === 'n' && nonce !== undefined) {
      pending.delete(nonce);
      await context.edit('Отменено. Ничего не записано.');
      return undefined;
    }
    if (
      entry === undefined ||
      entry.kind !== kind ||
      entry.expiresAtMs <= nowMs() ||
      nonce === undefined
    ) {
      await context.edit('⌛ Подтверждение устарело. Повторите команду.');
      return undefined;
    }
    return { entry, nonce };
  }

  async function contributionCommand(context: CommandContext): Promise<void> {
    const input = parseContribution(context.args);
    if (typeof input === 'string') {
      await context.reply(input);
      return;
    }
    let testId: string | undefined;
    let testText = '';
    if (input.test !== undefined) {
      const view = (await activeExperimentViews(database)).find(
        (item) => item.number === input.test,
      );
      if (view === undefined) {
        await context.reply(
          `Теста №${String(input.test)} нет среди текущих — номер из /experiments.`,
        );
        return;
      }
      testId = view.experiment.id;
      testText = ` · тест №${String(input.test)} «${shorten(view.opportunity.title, 60)}»`;
    }
    const nonce = remember({
      kind: 'contribution',
      input,
      ...(testId === undefined ? {} : { testId }),
    });
    await context.reply(
      [
        '🏆 Записать вклад?',
        `${input.handle} · ${CONTRIBUTION_KIND_LABELS[input.kind]}${testText}`,
        `«${shorten(input.description, 300)}»`,
        '',
        'Потом подтвердите его в /rewards — только подтверждённый вклад можно вознаградить.',
        'Подтверждение действует 10 минут.',
      ].join('\n'),
      confirmKeyboard(CONTRIBUTION_PREFIX, nonce, '🏆 Записать'),
    );
  }

  async function recordContribution(context: CallbackContext): Promise<void> {
    const confirmed = await confirmation(context, 'contribution');
    if (confirmed === undefined) return;
    const { entry, nonce } = confirmed;
    if (entry.kind !== 'contribution') return;
    const actor = deps.owner(context.userId);
    await database.command(
      {
        name: 'contribution.record',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${String(context.updateId)}`,
      },
      async ({ repositories }) => {
        const at = deps.now();
        const contribution = createContribution(
          {
            contributor: memberActor(entry.input.handle),
            kind: entry.input.kind,
            description: entry.input.description,
            ...(entry.testId === undefined
              ? {}
              : { subject: { type: 'experiment' as const, id: entry.testId } }),
            occurredAt: at,
          },
          { id: contributionIdSchema.parse(uuidv7()), actor, at },
        );
        await repositories.contributions.insert(contribution);
        return { id: contribution.id };
      },
    );
    pending.delete(nonce);
    context.logger.info('contribution recorded by the owner', { kind: entry.input.kind });
    await list(context, '🏆 Вклад записан. Проверьте его: ✅ или ❌ выше.');
    await context.answer('Записано');
  }

  async function reviewButton(context: CallbackContext): Promise<void> {
    const [action, rawId, rawVersion] = context.data.split(':');
    const id = contributionIdSchema.safeParse(rawId);
    const version = Number(rawVersion);
    if (
      !['v', 'yv', 'x', 'yx', 'c'].includes(action ?? '') ||
      !id.success ||
      !Number.isSafeInteger(version)
    ) {
      await context.answer('Кнопка устарела');
      return;
    }
    if (action === 'c') {
      await list(context);
      return;
    }
    const verify = action === 'v' || action === 'yv';
    if (action === 'v' || action === 'x') {
      const contribution = await database.repositories.contributions.getById(id.data);
      if (contribution?.version !== version || contribution.status !== 'recorded') {
        await list(context, STALE_TEXT);
        return;
      }
      const all = await numberedContributions(database.repositories);
      const number = all.findIndex((item) => item.id === contribution.id) + 1;
      await context.edit(
        `${await contributionLine(database.repositories, contribution, number)}\n\n` +
          (verify
            ? '❓ Подтвердить вклад? Подтверждённый вклад можно вознаградить (/reward).'
            : '❓ Отклонить вклад? Вознаградить его будет нельзя.'),
        [
          [
            contributionButton(
              verify ? '✅ Да, подтвердить' : '❌ Да, отклонить',
              `y${action}`,
              contribution,
            ),
            contributionButton('Назад', 'c', contribution),
          ],
        ],
      );
      return;
    }
    const actor = deps.owner(context.userId);
    let changed: boolean;
    try {
      ({ result: changed } = await database.command(
        {
          name: 'contribution.review',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async ({ repositories }) => {
          const contribution = await repositories.contributions.getById(id.data);
          if (contribution?.version !== version || contribution.status !== 'recorded') return false;
          await repositories.contributions.update(
            reviewContribution(
              contribution,
              { verdict: verify ? 'verify' : 'reject' },
              { actor, at: deps.now() },
            ),
            actor,
          );
          return true;
        },
      ));
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
      changed = false;
    }
    if (!changed) {
      await list(context, STALE_TEXT);
      return;
    }
    context.logger.info('contribution reviewed by the owner', { verified: verify });
    await list(
      context,
      verify
        ? '✅ Вклад подтверждён. Начислить: /reward <номер> $сумма или N%.'
        : '❌ Вклад отклонён.',
    );
    await context.answer('Записано');
  }

  async function rewardCommand(context: CommandContext): Promise<void> {
    const input = parseRewardCommand(context.args);
    if (typeof input === 'string') {
      await context.reply(input);
      return;
    }
    const contributions = await numberedContributions(database.repositories);
    const ids: ContributionId[] = [];
    for (const number of input.numbers) {
      const contribution = contributions[number - 1];
      if (contribution === undefined) {
        await context.reply(`Вклада №${String(number)} нет — номера из /rewards.`);
        return;
      }
      ids.push(contribution.id);
    }
    const { plan } = await planFrom(database, ids, input.terms);
    if (!plan.ok) {
      const which =
        plan.contributionId === undefined
          ? ''
          : ` (вклад №${String(contributions.findIndex((item) => item.id === plan.contributionId) + 1)})`;
      await context.reply(`⛔ ${REFUSALS[plan.reason]}${which}`);
      return;
    }
    const nonce = remember({
      kind: 'reward',
      contributionIds: ids,
      terms: input.terms,
      amount: plan.reward.amount,
    });
    await context.reply(
      [
        `🏆 Начислить ${handleOf(plan.reward.contributor)} ${formatUsd(plan.reward.amount)}?`,
        `Правило: ${termsText(input.terms, plan.base)}.`,
        `Вклады: ${input.numbers.map((item) => `№${String(item)}`).join(', ')}.`,
        '',
        `Дальше — выплата на одобрение в /decisions (D-006), ${String(PAYOUT_REQUEST_DAYS)} дней. Деньги система не переводит.`,
        'Подтверждение действует 10 минут.',
      ].join('\n'),
      confirmKeyboard(REWARD_PREFIX, nonce, '🏆 Начислить'),
    );
  }

  async function calculate(context: CallbackContext): Promise<void> {
    const confirmed = await confirmation(context, 'reward');
    if (confirmed === undefined) return;
    const { entry, nonce } = confirmed;
    if (entry.kind !== 'reward') return;
    const actor = deps.owner(context.userId);
    const { result } = await database.command(
      {
        name: 'reward.calculate',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${String(context.updateId)}`,
      },
      async (scope): Promise<{ readonly ok: boolean; readonly text?: string }> => {
        // The facts may have changed since the question: plan again and keep the confirmed sum.
        const { plan, contributions } = await planFrom(scope, entry.contributionIds, entry.terms);
        if (!plan.ok) return { ok: false, text: `⛔ ${REFUSALS[plan.reason]}` };
        if (plan.reward.amount.amountCents !== entry.amount.amountCents) {
          return { ok: false, text: '⚠️ Сумма изменилась с момента вопроса — повторите /reward.' };
        }
        const at = deps.now();
        const reward = calculateReward(
          {
            ...plan.reward,
            ...(entry.terms.rule === 'revenue_share'
              ? { note: termsText(entry.terms, plan.base) }
              : {}),
          },
          contributions,
          { id: rewardIdSchema.parse(uuidv7()), actor, at },
        );
        await scope.repositories.rewards.insert(reward);
        const request = createApprovalRequest(
          {
            kind: 'payout',
            title: shorten(
              `Выплата: ${handleOf(reward.contributor)} ${formatUsd(reward.amount)}`,
              200,
            ),
            summary: shorten(
              `${RULE_LABELS[reward.ruleId] ?? reward.ruleId}${reward.note === undefined ? '' : ` (${reward.note})`}. ` +
                contributions
                  .map((item) => `${CONTRIBUTION_KIND_LABELS[item.kind]}: ${item.description}`)
                  .join(' · '),
              3_000,
            ),
            amount: reward.amount,
            subject: { type: 'reward', id: reward.id },
            expiresAt: toTimestamp(new Date(timestampMs(at) + PAYOUT_REQUEST_DAYS * DAY_MS)),
          },
          { id: approvalRequestIdSchema.parse(uuidv7()), actor, at },
        );
        await scope.repositories.approvalRequests.insert(request);
        return { ok: true };
      },
    );
    pending.delete(nonce);
    if (!result.ok) {
      await list(context, result.text);
      return;
    }
    context.logger.info('reward calculated by the owner', { rule: entry.terms.rule });
    await list(context, '🏆 Начислено. Выплата ждёт вашего решения в /decisions.');
    await context.answer('Начислено');
  }

  async function paidCommand(context: CommandContext): Promise<void> {
    const input = parsePaid(context.args);
    if (typeof input === 'string') {
      await context.reply(input);
      return;
    }
    const reward = (await numberedRewards(database.repositories))[input.number - 1];
    if (reward === undefined) {
      await context.reply(`Начисления №${String(input.number)} нет — номера из /rewards.`);
      return;
    }
    if (reward.status !== 'payable') {
      await context.reply(
        reward.status === 'paid'
          ? `Начисление №${String(input.number)} уже выплачено.`
          : `Начисление №${String(input.number)} ещё не одобрено к выплате: ✅ в /decisions.`,
      );
      return;
    }
    const nonce = remember({ kind: 'paid', rewardId: reward.id, reference: input.reference });
    await context.reply(
      [
        `💸 Отметить выплату №${String(input.number)}: ${handleOf(reward.contributor)} ${formatUsd(reward.amount)}?`,
        `Перевод: «${shorten(input.reference, 200)}».`,
        'Запишется расход «Люди» за этот месяц (/economics).',
        '',
        'Подтверждение действует 10 минут.',
      ].join('\n'),
      confirmKeyboard(REWARD_PREFIX, nonce, '💸 Выплачено'),
    );
  }

  async function recordPayout(context: CallbackContext): Promise<void> {
    const confirmed = await confirmation(context, 'paid');
    if (confirmed === undefined) return;
    const { entry, nonce } = confirmed;
    if (entry.kind !== 'paid') return;
    const actor = deps.owner(context.userId);
    const { result } = await database.command(
      {
        name: 'reward.paid',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${String(context.updateId)}`,
      },
      async ({ repositories }): Promise<boolean> => {
        const reward = await repositories.rewards.getById(rewardIdSchema.parse(entry.rewardId));
        if (reward?.status !== 'payable' || reward.approvalRequestId === undefined) return false;
        const approval = await repositories.approvalRequests.getById(reward.approvalRequestId);
        const at = deps.now();
        const payout = recordRewardPayout(
          reward,
          { paidAt: at, reference: entry.reference },
          approval,
          {
            id: costEntryIdSchema.parse(uuidv7()),
            actor,
            at,
          },
        );
        await repositories.rewards.update(payout.reward, actor);
        await repositories.costEntries.insert(payout.cost);
        return true;
      },
    );
    pending.delete(nonce);
    if (!result) {
      await list(context, STALE_TEXT);
      return;
    }
    context.logger.info('reward payout recorded by the owner');
    await list(context, '✅ Выплата записана: расход «Люди» в /economics.');
    await context.answer('Записано');
  }

  async function cancelButton(context: CallbackContext): Promise<void> {
    const [action, rawId, rawVersion] = context.data.split(':');
    const id = rewardIdSchema.safeParse(rawId);
    const version = Number(rawVersion);
    if (!['k', 'yk', 'c'].includes(action ?? '') || !id.success || !Number.isSafeInteger(version)) {
      await context.answer('Кнопка устарела');
      return;
    }
    if (action === 'c') {
      await list(context);
      return;
    }
    const cancellable = (reward: Reward | undefined): reward is Reward =>
      reward?.version === version && ['calculated', 'payable'].includes(reward.status);
    if (action === 'k') {
      const reward = await database.repositories.rewards.getById(id.data);
      if (!cancellable(reward)) {
        await list(context, STALE_TEXT);
        return;
      }
      await context.edit(
        `🏆 ${handleOf(reward.contributor)} · ${formatUsd(reward.amount)}\n\n` +
          '❓ Отменить начисление? Вклады снова можно будет вознаградить, запрос выплаты закроется.',
        [[rewardButton('✖️ Да, отменить', 'yk', reward), rewardButton('Назад', 'c', reward)]],
      );
      return;
    }
    const actor = deps.owner(context.userId);
    let changed: boolean;
    try {
      ({ result: changed } = await database.command(
        {
          name: 'reward.cancel',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async ({ repositories }) => {
          const reward = await repositories.rewards.getById(id.data);
          if (!cancellable(reward)) return false;
          const at = deps.now();
          await repositories.rewards.update(cancelReward(reward, { actor, at }), actor);
          // A payout request still waiting in /decisions closes with the reward.
          const request = (await payoutRequests(repositories)).get(reward.id);
          if (request !== undefined && !isApprovalExpired(request, at)) {
            await repositories.approvalRequests.update(
              cancelApprovalRequest(request, { actor, at }),
              actor,
            );
          }
          return true;
        },
      ));
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
      changed = false;
    }
    if (!changed) {
      await list(context, STALE_TEXT);
      return;
    }
    context.logger.info('reward cancelled by the owner');
    await list(context, '✖️ Начисление отменено.');
    await context.answer('Отменено');
  }

  return {
    async rewards(context) {
      const reply = await rewardsReply(database, nowMs());
      await context.reply(reply.text, reply.keyboard);
    },
    contribution: contributionCommand,
    reward: rewardCommand,
    paid: paidCommand,
    async handleContributionButton(context) {
      const [action] = context.data.split(':');
      if (action === 'y' || action === 'n') await recordContribution(context);
      else await reviewButton(context);
    },
    async handleRewardButton(context) {
      const [action, nonce] = context.data.split(':');
      if (action === 'y' || action === 'n') {
        const entry = nonce === undefined ? undefined : pending.get(nonce);
        if (entry?.kind === 'paid') await recordPayout(context);
        else await calculate(context);
        return;
      }
      await cancelButton(context);
    },
  };
}

// ---------------------------------------------------------------- Payout decision

/**
 * Applies the owner's decision on a `payout` request in /decisions (PHASE 17, D-006): approved —
 * the reward becomes payable; rejected — it is cancelled and its contributions are free again.
 */
export async function applyPayoutDecision(
  repositories: Repositories,
  request: ApprovalRequest,
  actor: Actor,
  at: Timestamp,
): Promise<'payout_approved' | 'payout_rejected' | undefined> {
  if (request.kind !== 'payout' || request.subject?.type !== 'reward') return undefined;
  const reward = await repositories.rewards.getById(rewardIdSchema.parse(request.subject.id));
  if (reward?.status !== 'calculated') return undefined;
  const context = { actor, at };
  if (request.status === 'approved') {
    const approved = approveReward(reward, request, context);
    await repositories.rewards.update(approved, actor);
    await repositories.rewards.update(markRewardPayable(approved, context), actor);
    return 'payout_approved';
  }
  await repositories.rewards.update(cancelReward(reward, context), actor);
  return 'payout_rejected';
}
