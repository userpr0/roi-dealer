import { randomBytes } from 'node:crypto';
import {
  experimentTotalBudget,
  formatUsd,
  portfolioLimitsSchema,
  recommendPortfolio,
  startOfUtcMonth,
  timestampMs,
  usd,
  type Actor,
  type OpportunityStatus,
  type PortfolioCandidate,
  type PortfolioLimits,
  type PortfolioSkip,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import { callbackButton, type CallbackContext, type CommandContext } from '@roi-dealer/telegram';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';
import { monthTitle } from './roi.js';
import { shorten } from './texts.js';
import { METHOD_LABELS, type ExperimentView } from './experiments.js';

/*
 * The portfolio of tests (phase 26, ADR-0013): /allocate shows the month's test budget, what the
 * tests took and which hypotheses code recommends for the money left; `/allocate 300 страна 150
 * возможность 100` sets the budget after a confirmation. Launching a test stays as it was.
 */

export const ALLOCATE_PREFIX = 'al';
export const ALLOCATE_USAGE =
  'Бюджет тестов: /allocate 300 страна 150 возможность 100 — $300 на месяц, не больше $150 на страну и $100 на одну возможность.';

/** How many picks and skips /allocate shows. */
const SHOWN_PICKS = 10;
const SHOWN_SKIPS = 5;
const MAX_PENDING = 20;
const OPEN_OPPORTUNITIES: readonly OpportunityStatus[] = ['approved', 'validating', 'scaling'];

const SKIP_TEXT: Readonly<Record<PortfolioSkip, string>> = {
  total: 'не хватает бюджета месяца',
  country: 'лимит страны',
  opportunity: 'лимит возможности',
};

/** 'YYYY-MM' of a UTC month and its bounds. */
export function portfolioMonth(nowMs: number): {
  readonly month: string;
  readonly from: string;
  readonly to: string;
} {
  const start = new Date(startOfUtcMonth(nowMs));
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return {
    month: start.toISOString().slice(0, 7),
    from: start.toISOString(),
    to: next.toISOString(),
  };
}

const money = (cents: number) => formatUsd(usd(cents));
const amount = /\$?\s*(\d{1,6}(?:[.,]\d{1,2})?)/u;
const toCents = (value: string) => Math.round(Number(value.replace(',', '.')) * 100);

/** `/allocate 300 страна 150 возможность 100`; the limits default to the month budget. */
export function parseAllocate(args: string): PortfolioLimits | string {
  const text = args.trim().toLowerCase();
  const total = amount.exec(text);
  if (total?.[1] === undefined) return ALLOCATE_USAGE;
  const country = /стран\S*\s*\$?\s*(\d{1,6}(?:[.,]\d{1,2})?)/u.exec(text)?.[1];
  const opportunity = /(?:возможност|ниш)\S*\s*\$?\s*(\d{1,6}(?:[.,]\d{1,2})?)/u.exec(text)?.[1];
  const totalCents = toCents(total[1]);
  const parsed = portfolioLimitsSchema.safeParse({
    totalCents,
    countryCents: country === undefined ? totalCents : toCents(country),
    opportunityCents: opportunity === undefined ? totalCents : toCents(opportunity),
  });
  if (!parsed.success) {
    return `⛔ Лимиты на страну и возможность — не больше бюджета месяца, бюджет — от $1 до $10 000.\n${ALLOCATE_USAGE}`;
  }
  return parsed.data;
}

interface CandidateInfo {
  readonly candidate: PortfolioCandidate;
  readonly title: string;
  readonly method: string;
}

/**
 * Hypotheses that could get money: proposed ones, and selected ones whose test is only planned,
 * of opportunities in work.
 */
async function candidates(database: Database): Promise<CandidateInfo[]> {
  const { repositories } = database;
  const opportunities = (
    await Promise.all(
      OPEN_OPPORTUNITIES.map((status) =>
        repositories.opportunities.listByStatus(status, { limit: 1_000 }),
      ),
    )
  ).flat();
  if (opportunities.length === 0) return [];
  const ids = opportunities.map((item) => item.id);
  const [hypotheses, planned, scores] = await Promise.all([
    repositories.hypotheses.listByOpportunities(ids),
    repositories.experiments.listByStatus('planned', { limit: 1_000 }),
    database.opportunityAssessments.scores(ids),
  ]);
  const plannedHypotheses = new Set(planned.map((item) => item.hypothesisId));
  const titles = new Map(opportunities.map((item) => [item.id, item.title]));
  const results = new Map<string, { confirmed: number; refuted: number }>();
  for (const item of hypotheses) {
    const own = results.get(item.opportunityId) ?? { confirmed: 0, refuted: 0 };
    if (item.status === 'confirmed') own.confirmed += 1;
    if (item.status === 'refuted') own.refuted += 1;
    results.set(item.opportunityId, own);
  }
  return hypotheses
    .filter(
      (item) =>
        item.status === 'proposed' ||
        (item.status === 'selected' && plannedHypotheses.has(item.id)),
    )
    .map((item) => ({
      candidate: {
        hypothesisId: item.id,
        opportunityId: item.opportunityId,
        geo: item.geo,
        budgetCents: item.budget.amountCents,
        // An opportunity without a recorded score starts from an even chance.
        score: scores.get(item.opportunityId)?.score ?? 50,
        confirmed: results.get(item.opportunityId)?.confirmed ?? 0,
        refuted: results.get(item.opportunityId)?.refuted ?? 0,
      },
      title: titles.get(item.opportunityId) ?? '—',
      method: METHOD_LABELS[item.validationMethod],
    }));
}

const percent = (value: number) => `${String(Math.round(value * 100))}%`;

/** /allocate without arguments: the budget, what is taken and the recommendation of code. */
export async function allocateText(database: Database, nowMs: number): Promise<string> {
  const period = portfolioMonth(nowMs);
  const budget = await database.portfolio.budget(period.month);
  if (budget === undefined) {
    return ['🎯 Бюджет тестов на месяц не задан.', ALLOCATE_USAGE].join('\n');
  }
  const [committed, found] = await Promise.all([
    database.portfolio.committed(period),
    candidates(database),
  ]);
  const byId = new Map(found.map((item) => [item.candidate.hypothesisId, item]));
  const advice = recommendPortfolio({
    month: period.month,
    limits: budget,
    committed,
    candidates: found.map((item) => item.candidate),
  });
  const line = (pick: { candidate: PortfolioCandidate; chance: number }) => {
    const info = byId.get(pick.candidate.hypothesisId);
    return (
      `«${shorten(info?.title ?? '—', 80)}» — ${info?.method ?? ''} · ${pick.candidate.geo} · ` +
      `${money(pick.candidate.budgetCents)} · шанс ~${percent(pick.chance)}`
    );
  };
  const lines = [
    `🎯 Портфель тестов · ${monthTitle(period.month)}`,
    `Бюджет месяца ${money(budget.totalCents)} · занято ${money(committed.totalCents)} · свободно ${money(advice.freeCents + advice.picks.reduce((sum, pick) => sum + pick.candidate.budgetCents, 0))}`,
    `Лимиты: страна ${money(budget.countryCents)} · возможность ${money(budget.opportunityCents)}`,
    '',
  ];
  if (found.length === 0) {
    lines.push('Гипотез для новых тестов нет — они появятся после одобрения возможностей.');
  } else {
    lines.push(
      advice.picks.length === 0
        ? 'Рекомендация кода: в этом месяце новых тестов нет — бюджет или лимиты заняты.'
        : 'Рекомендация кода (сэмплирование Томпсона по итогам тестов):',
      ...advice.picks
        .slice(0, SHOWN_PICKS)
        .map((pick, index) => `${String(index + 1)}. ${line(pick)}`),
      ...advice.skipped
        .slice(0, SHOWN_SKIPS)
        .map((pick) => `Не входит: ${line(pick)} — ${SKIP_TEXT[pick.reason]}`),
    );
  }
  lines.push(
    '',
    'Запуск — как обычно: /hypotheses → тест → запуск в /decisions. Решаете вы.',
    `Изменить: /allocate ${String(budget.totalCents / 100)} страна ${String(budget.countryCents / 100)} возможность ${String(budget.opportunityCents / 100)}`,
  );
  return lines.join('\n');
}

/** Lines for the launch question of a test: the month's budget before and after it. */
export async function portfolioLaunchLines(
  database: Database,
  view: ExperimentView,
  nowMs: number,
): Promise<string[]> {
  const period = portfolioMonth(nowMs);
  const budget = await database.portfolio.budget(period.month);
  if (budget === undefined) return [];
  const committed = await database.portfolio.committed(period);
  const taken = ['awaiting_approval', 'approved'].includes(view.experiment.status);
  const cents = taken ? 0 : experimentTotalBudget(view.experiment).amountCents;
  const geo = view.hypothesis.geo;
  const lines = [
    `🎯 Портфель месяца: занято ${money(committed.totalCents)} → ${money(committed.totalCents + cents)} из ${money(budget.totalCents)}`,
  ];
  if (committed.totalCents + cents > budget.totalCents) {
    lines.push('⚠️ Сверх бюджета тестов месяца — решаете вы.');
  }
  if ((committed.byCountry[geo] ?? 0) + cents > budget.countryCents) {
    lines.push(`⚠️ Сверх лимита на страну ${geo} (${money(budget.countryCents)}).`);
  }
  if ((committed.byOpportunity[view.opportunity.id] ?? 0) + cents > budget.opportunityCents) {
    lines.push(`⚠️ Сверх лимита на возможность (${money(budget.opportunityCents)}).`);
  }
  return lines;
}

export interface AllocateFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (userId: number) => Actor;
}

export interface AllocateFlow {
  readonly allocate: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

/** /allocate: shows the portfolio; with numbers — asks to set the budget, then records it. */
export function createAllocateFlow(deps: AllocateFlowDeps): AllocateFlow {
  const pending = new Map<string, { limits: PortfolioLimits; expiresAtMs: number }>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(limits: PortfolioLimits): string {
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
    pending.set(nonce, { limits, expiresAtMs: current + CONFIRMATION_TTL_MS });
    return nonce;
  }

  return {
    async allocate(context) {
      if (context.args.trim() === '') {
        await context.reply(await allocateText(deps.database, nowMs()));
        return;
      }
      const limits = parseAllocate(context.args);
      if (typeof limits === 'string') {
        await context.reply(limits);
        return;
      }
      const { month } = portfolioMonth(nowMs());
      const nonce = remember(limits);
      await context.reply(
        [
          `🎯 Задать бюджет тестов с месяца «${monthTitle(month)}»?`,
          `Месяц ${money(limits.totalCents)} · на страну до ${money(limits.countryCents)} · на возможность до ${money(limits.opportunityCents)}`,
          'Действует, пока вы его не измените. Деньги тратятся только после одобренного запуска каждого теста.',
          '',
          'Подтверждение действует 10 минут.',
        ].join('\n'),
        [
          [
            callbackButton('🎯 Задать', `${ALLOCATE_PREFIX}:y:${nonce}`),
            callbackButton('Отмена', `${ALLOCATE_PREFIX}:n:${nonce}`),
          ],
        ],
      );
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
        await context.edit('⌛ Подтверждение устарело. Повторите /allocate.');
        return;
      }
      const actor = deps.owner(context.userId);
      const { month } = portfolioMonth(nowMs());
      await deps.database.command(
        {
          name: 'portfolio.budget',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async (scope) => {
          await scope.portfolio.setBudget({
            ...confirmation.limits,
            month,
            actorId: actor.id,
            correlationId: `tg-update-${String(context.updateId)}`,
          });
          return { month };
        },
      );
      pending.delete(nonce ?? '');
      await context.edit('🎯 Бюджет тестов задан. Рекомендация — /allocate.');
    },
  };
}
