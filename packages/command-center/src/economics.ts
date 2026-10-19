import { randomBytes } from 'node:crypto';
import {
  addMoney,
  approvalRequestIdSchema,
  budgetState,
  costEntryIdSchema,
  createApprovalRequest,
  DEFAULT_APPROVAL_POLICY,
  formatUsd,
  MONTHLY_LIMITS,
  recordCostEntry,
  requiresOwnerApproval,
  resolveApprovalRequest,
  startOfUtcMonth,
  timestampMs,
  toTimestamp,
  usd,
  ZERO_USD,
  type Actor,
  type BudgetState,
  type CostCategory,
  type Money,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import { aiCents, monthReport, type EconomicsReport } from '@roi-dealer/economics';
import { uuidv7 } from '@roi-dealer/shared';
import { callbackButton, type CallbackContext, type CommandContext } from '@roi-dealer/telegram';
import { formatMicroUsd } from './ai-status.js';
import { shorten } from './texts.js';

/*
 * Economics in the panel (PHASE 16): /economics — the month against the D-007 limits, tests,
 * revenue, ROI and the cost of a tested hypothesis, from the ledgers; /cost — a cost the owner
 * paid outside the tests, with confirmation and, above $20, the owner's approval (D-006).
 */

/** Buttons of /cost confirmations: `co:<y|n>:<nonce>`. */
export const COST_PREFIX = 'co';
/** The most one /cost may record. */
export const MAX_RECORDED_COST_USD = 10_000;
const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const DAY_MS = 86_400_000;

export const COST_LABELS: Readonly<Record<CostCategory, string>> = {
  ai: 'AI',
  api: 'API',
  infrastructure: 'Инфраструктура',
  storage: 'Хранение',
  media: 'Медиа',
  ads: 'Реклама тестов',
  human: 'Люди',
  refund: 'Возвраты клиентам',
  vendor: 'Подрядчики',
  other: 'Другое',
};

/** Categories /cost records; AI is recorded automatically, ads and refunds through /funnel. */
const COST_WORDS: Readonly<Record<string, CostCategory>> = {
  инфраструктура: 'infrastructure',
  infrastructure: 'infrastructure',
  infra: 'infrastructure',
  api: 'api',
  хранение: 'storage',
  storage: 'storage',
  медиа: 'media',
  media: 'media',
  люди: 'human',
  human: 'human',
  подрядчики: 'vendor',
  vendor: 'vendor',
  другое: 'other',
  other: 'other',
};

const STATE_MARKS: Readonly<Record<BudgetState, string>> = { ok: '', warning: ' ⚠️', over: ' ⛔' };

function percent(spent: Money, limit: Money): string {
  return `${String(Math.round((spent.amountCents / limit.amountCents) * 100))} %`;
}

/** /economics: the month so far, every number with its source (§7.3). */
export function economicsText(report: EconomicsReport): string {
  const lines = [
    `💸 Экономика · ${report.month} (UTC, с начала месяца)`,
    '',
    `Расходы: ${formatUsd(report.totalCosts)}`,
  ];
  const limited = new Set(report.budgets.map((line) => line.category));
  for (const line of report.budgets) {
    lines.push(
      `· ${COST_LABELS[line.category]} ${formatUsd(line.spent)} из ${formatUsd(line.limit)} ` +
        `(${percent(line.spent, line.limit)})${STATE_MARKS[line.state]}` +
        (line.category === 'ai'
          ? ` · сегодня ${formatMicroUsd(report.ai.todayMicroUsd)} из ${formatMicroUsd(report.ai.allowanceMicroUsd)}`
          : ''),
    );
  }
  for (const [category, amount] of report.costs) {
    if (limited.has(category) || amount.amountCents === 0) continue;
    lines.push(`· ${COST_LABELS[category]} ${formatUsd(amount)}`);
  }
  if (report.budgets.some((line) => line.state === 'over')) {
    lines.push('⛔ Лимит D-007 превышен: лимит меняется только вашим решением.');
  }
  lines.push(
    '',
    report.tests.active === 0
      ? 'Тестов с одобренным запуском нет.'
      : `Тесты: ${String(report.tests.active)} · потрачено ${formatUsd(report.tests.spent)} из одобренных ${formatUsd(report.tests.approved)}`,
    `Выручка: оплаты ${formatUsd(report.revenue.payments)} · предзаказы ${formatUsd(report.revenue.preorders)} · клиентов ${String(report.revenue.customers)} · возвраты ${formatUsd(report.refunds)}`,
  );
  if (report.revenue.preorders.amountCents > 0) {
    lines.push('Предзаказы — обязательство: если продукта не будет, деньги возвращаются.');
  }
  lines.push(
    report.roiPercent === undefined
      ? 'ROI системы: расходов ещё нет.'
      : `ROI системы: ${String(report.roiPercent)} % (оплаты − возвраты / все расходы)`,
    report.costPerTestedHypothesis === undefined
      ? 'Проверенных гипотез пока нет.'
      : `Проверенных гипотез: ${String(report.testedHypotheses)} · стоимость одной ${formatUsd(report.costPerTestedHypothesis)}`,
    '',
    'Источник: cost_entries, revenue_entries, ai_calls → /history',
  );
  return lines.join('\n');
}

export async function economicsReply(database: Database, nowMs: number): Promise<string> {
  return economicsText(await monthReport(database, nowMs));
}

export const COST_USAGE = [
  '💸 Записать расход: /cost <сумма> <категория> <за что>',
  'Например: /cost 5 инфраструктура Railway октябрь',
  'Категории: инфраструктура, api, хранение, медиа, люди, подрядчики, другое.',
  'AI записывается сам; траты и возвраты тестов — через /funnel.',
].join('\n');

export interface CostReport {
  readonly amount: Money;
  readonly category: CostCategory;
  readonly description: string;
}

/** Parses `/cost` arguments, or explains what is wrong (in Russian, for the owner). */
export function parseCostReport(args: string): CostReport | string {
  const [rawAmount, rawCategory, ...rest] = args.trim().split(/\s+/);
  if (rawAmount === undefined || rawAmount === '') return COST_USAGE;
  const value = Number(rawAmount.replace(/^\$/, '').replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_RECORDED_COST_USD) {
    return `Сумма — от $0.01 до $${String(MAX_RECORDED_COST_USD)}.\n\n${COST_USAGE}`;
  }
  const category = rawCategory === undefined ? undefined : COST_WORDS[rawCategory.toLowerCase()];
  if (category === undefined)
    return `Не знаю категорию «${shorten(rawCategory ?? '', 30)}».\n\n${COST_USAGE}`;
  const description = rest.join(' ').trim();
  if (description === '') return `Напишите, за что расход.\n\n${COST_USAGE}`;
  return { amount: usd(Math.round(value * 100)), category, description: shorten(description, 500) };
}

export interface CostFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

export interface CostFlow {
  readonly cost: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

interface PendingCost {
  readonly report: CostReport;
  readonly expiresAtMs: number;
}

/** The month's costs of the category so far. */
async function monthSpent(
  database: Database,
  category: CostCategory,
  nowMs: number,
): Promise<Money> {
  const period = {
    from: toTimestamp(new Date(startOfUtcMonth(nowMs))),
    to: toTimestamp(new Date(nowMs + 1)),
  };
  if (category === 'ai') return aiCents((await database.aiCalls.spend(period)).costMicroUsd);
  return (await database.economics.costsByCategory(period)).get(category) ?? ZERO_USD;
}

/**
 * /cost records a cost the owner paid, so it asks for confirmation first (the month against the
 * limit). The write is one idempotent owner command; above $20 the confirmation is the owner's
 * approval of the spend (D-006): the command creates the `spend` request, approves it as the
 * owner and records the cost with it.
 */
export function createCostFlow(deps: CostFlowDeps): CostFlow {
  const pending = new Map<string, PendingCost>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(report: CostReport): string {
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
    pending.set(nonce, { report, expiresAtMs: current + CONFIRMATION_TTL_MS });
    return nonce;
  }

  return {
    async cost(context) {
      const report = parseCostReport(context.args);
      if (typeof report === 'string') {
        await context.reply(report);
        return;
      }
      const spent = await monthSpent(deps.database, report.category, nowMs());
      const after = addMoney(spent, report.amount);
      const limit = MONTHLY_LIMITS[report.category];
      const lines = [
        '💸 Записать расход?',
        `${COST_LABELS[report.category]} · ${formatUsd(report.amount)} · «${shorten(report.description, 120)}»`,
        limit === undefined
          ? `За месяц станет ${formatUsd(after)}.`
          : `За месяц станет ${formatUsd(after)} из ${formatUsd(limit)} (${percent(after, limit)}).`,
      ];
      if (limit !== undefined && budgetState(after, limit) === 'over') {
        lines.push(
          `⚠️ Сверх лимита D-007 (${formatUsd(limit)}): запись — факт, лимит меняется только вашим решением.`,
        );
      }
      if (requiresOwnerApproval({ kind: 'spend', amount: report.amount })) {
        lines.push(
          `Выше ${formatUsd(DEFAULT_APPROVAL_POLICY.spendThreshold)}: подтверждение — ваше одобрение траты (D-006).`,
        );
      }
      lines.push('', 'Подтверждение действует 10 минут.');
      const nonce = remember(report);
      await context.reply(lines.join('\n'), [
        [
          callbackButton('💸 Записать', `${COST_PREFIX}:y:${nonce}`),
          callbackButton('Отмена', `${COST_PREFIX}:n:${nonce}`),
        ],
      ]);
    },

    async handleButton(context) {
      const [answer, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (answer === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (answer !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /cost.');
        return;
      }
      const actor = deps.owner(context.userId);
      const { report } = confirmation;
      const { outcome } = await deps.database.command(
        {
          name: 'economics.cost',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async ({ repositories }) => {
          const at = deps.now();
          let approval;
          if (requiresOwnerApproval({ kind: 'spend', amount: report.amount })) {
            const request = createApprovalRequest(
              {
                kind: 'spend',
                title: shorten(
                  `Расход: ${COST_LABELS[report.category]} ${formatUsd(report.amount)}`,
                  200,
                ),
                summary: report.description,
                amount: report.amount,
                expiresAt: toTimestamp(new Date(timestampMs(at) + DAY_MS)),
              },
              { id: approvalRequestIdSchema.parse(uuidv7()), actor, at },
            );
            await repositories.approvalRequests.insert(request);
            approval = resolveApprovalRequest(
              request,
              { decision: 'approve', comment: 'Confirmed with /cost' },
              { actor, at },
            );
            await repositories.approvalRequests.update(approval, actor);
          }
          const entry = recordCostEntry(
            {
              category: report.category,
              amount: report.amount,
              description: report.description,
              incurredAt: at,
              recurring: false,
              allocation: {},
              ...(approval === undefined ? {} : { approvalRequestId: approval.id }),
            },
            { id: costEntryIdSchema.parse(uuidv7()), actor, at },
            approval,
          );
          await repositories.costEntries.insert(entry);
          return { id: entry.id };
        },
      );
      pending.delete(nonce ?? '');
      context.logger.info('owner cost recorded', { outcome, category: report.category });
      await context.edit(
        `💸 Записано: ${COST_LABELS[report.category]} ${formatUsd(report.amount)}. Месяц — /economics.`,
      );
      await context.answer('Записано');
    },
  };
}
