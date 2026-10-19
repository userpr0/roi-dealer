import {
  formatUsd,
  metricReached,
  metricValue,
  proposeExperimentOutcome,
  toTimestamp,
  type Timestamp,
} from '@roi-dealer/domain';
import type { CycleCounts, Database } from '@roi-dealer/database';
import { monthReport } from '@roi-dealer/economics';
import type { InlineKeyboard } from '@roi-dealer/telegram';
import { COST_LABELS } from './economics.js';
import {
  activeExperimentViews,
  experimentCardText,
  outcomeLabel,
  PROPOSAL_REASONS,
  proposalKeyboard,
} from './experiments.js';
import { buildDigest } from './digest.js';
import { formatKyivDate } from './kyiv-time.js';

/*
 * Statistics and the weekly review (PHASE 13, D-014 п.11–12): the cycle from evidence to
 * revenue, the system's own metrics and, once a week, the system's proposals for the tests with
 * buttons — every number from the database with its source (§7.3); the owner decides.
 */

const DAY_MS = 86_400_000;
export const STATS_DAYS = 30;
export const REVIEW_DAYS = 7;

const iso = (ms: number): Timestamp => toTimestamp(new Date(ms));

const DECISION_LABELS: Readonly<Record<string, string>> = {
  approve: 'проверять',
  reject: 'не брать',
  more_research: 'доисследовать',
  pause: 'пауза',
  kill: 'закрыть',
  scale: 'масштабировать',
  improve: 'улучшить',
  pivot: 'сменить подход',
};

function cycleLines(counts: CycleCounts): string[] {
  return [
    `Доказательства ${String(counts.evidence)} → сигналы ${String(counts.signals)} → боли ${String(counts.pains)} (подтверждено ${String(counts.painsValidated)})`,
    `Возможности ${String(counts.opportunities)} · на решении ${String(counts.opportunitiesUnderReview)} · в работе ${String(counts.opportunitiesInWork)}`,
    `Гипотезы ${String(counts.hypotheses)} → тесты запущено ${String(counts.experimentsStarted)}, завершено ${String(counts.experimentsCompleted)}`,
    `Клиенты ${String(counts.customers)} · выручка ${formatUsd(counts.revenue)}`,
  ];
}

/** The system's metrics of D-014 п.11 for the period ending now. */
async function metricLines(database: Database, nowMs: number, days: number): Promise<string[]> {
  const period = { from: iso(nowMs - days * DAY_MS), to: iso(nowMs + 1) };
  const [latency, knowledge, month] = await Promise.all([
    database.stats.decisionLatencyDays(period),
    database.stats.newKnowledge(period),
    monthReport(database, nowMs),
  ]);
  return [
    latency === undefined
      ? 'От сигнала до решения: решений ещё не было.'
      : `От сигнала до решения: ${String(latency)} дн. (медиана)`,
    `Новых знаний: ${String(knowledge)}`,
    month.roiPercent === undefined
      ? 'ROI системы за месяц: расходов ещё нет.'
      : `ROI системы за месяц: ${String(month.roiPercent)} %`,
    month.costPerTestedHypothesis === undefined
      ? 'Проверенных гипотез за месяц нет.'
      : `Проверенная гипотеза стоит ${formatUsd(month.costPerTestedHypothesis)} (за месяц: ${String(month.testedHypotheses)})`,
  ];
}

/** /stats: the cycle for 30 days and all time, and the system's metrics. */
export async function statsText(database: Database, nowMs: number): Promise<string> {
  const [recent, all] = await Promise.all([
    database.stats.cycle(iso(nowMs - STATS_DAYS * DAY_MS)),
    database.stats.cycle(),
  ]);
  return [
    `📊 Статистика · ${formatKyivDate(nowMs)}`,
    '',
    `За ${String(STATS_DAYS)} дней:`,
    ...cycleLines(recent),
    '',
    'За всё время:',
    ...cycleLines(all),
    '',
    'Метрики системы:',
    ...(await metricLines(database, nowMs, STATS_DAYS)),
    '',
    'Источник: таблицы БД (доказательства, боли, возможности, гипотезы, тесты, revenue_entries, cost_entries, ai_calls)',
  ].join('\n');
}

/** The weekly review's summary (D-014 п.12): the week's decisions, tests, money and metrics. */
export async function weeklyReviewText(database: Database, nowMs: number): Promise<string> {
  const period = { from: iso(nowMs - REVIEW_DAYS * DAY_MS), to: iso(nowMs + 1) };
  const [decisions, week, month] = await Promise.all([
    database.stats.decisionsByOutcome(period),
    database.stats.cycle(period.from),
    monthReport(database, nowMs),
  ]);
  const opportunityDecisions = decisions.filter((item) => item.subject === 'opportunity');
  const results = decisions.filter((item) => item.subject === 'experiment');
  const list = (items: typeof decisions) =>
    items
      .map((item) => `${DECISION_LABELS[item.outcome] ?? item.outcome} ${String(item.count)}`)
      .join(', ');
  return [
    `🗓 Недельный разбор · ${formatKyivDate(nowMs)}`,
    '',
    opportunityDecisions.length === 0
      ? 'Решений по возможностям за неделю не было.'
      : `Решения по возможностям: ${list(opportunityDecisions)}`,
    results.length === 0 ? 'Итогов тестов за неделю не было.' : `Итоги тестов: ${list(results)}`,
    `За неделю: доказательств ${String(week.evidence)}, болей ${String(week.pains)}, возможностей ${String(week.opportunities)}, гипотез ${String(week.hypotheses)}, клиентов ${String(week.customers)}, выручка ${formatUsd(week.revenue)}`,
    '',
    `Расходы месяца: ${formatUsd(month.totalCosts)} · ` +
      month.budgets
        .map(
          (line) =>
            `${COST_LABELS[line.category]} ${formatUsd(line.spent)} из ${formatUsd(line.limit)}`,
        )
        .join(' · '),
    ...(await metricLines(database, nowMs, REVIEW_DAYS)),
    '',
    'Предложения системы по тестам — следующими сообщениями. Решаете вы. Источник: таблицы БД → /stats, /economics',
  ].join('\n');
}

export interface ReviewProposal {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
}

/** One message per test with a proposal: its card, the proposal and its reason, the buttons. */
export async function weeklyProposals(
  database: Database,
  nowMs: number,
): Promise<ReviewProposal[]> {
  const at = iso(nowMs);
  const proposals: ReviewProposal[] = [];
  for (const view of await activeExperimentViews(database)) {
    const metric = view.experiment.successMetric;
    const reached = metricReached(metric, metricValue(metric, view.totals));
    const outcome = proposeExperimentOutcome(view.experiment, reached, at);
    if (outcome === undefined) continue;
    proposals.push({
      text:
        `${experimentCardText(view, at)}\n\n💡 Предложение системы: ${outcomeLabel(outcome)} — ` +
        `${PROPOSAL_REASONS[outcome]}. Решаете вы.`,
      keyboard: proposalKeyboard(view.experiment, outcome),
    });
  }
  return proposals;
}

/** Monday by the Kyiv calendar: the weekly review replaces the daily digest. */
export function isReviewDay(kyivDate: string): boolean {
  return new Date(`${kyivDate}T12:00:00.000Z`).getUTCDay() === 1;
}

/**
 * Sends the weekly review on Monday instead of the daily digest (D-014 п.12), once: the command
 * key is the digest's `digest-<date>`. The summary and the daily digest go as one message, then
 * one message per proposal with its buttons (when cards can be delivered).
 */
export async function sendWeeklyReview(
  database: Database,
  date: string,
  nowMs: number,
  deliver: (text: string) => Promise<void>,
  deliverCard?: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<'sent' | 'already_sent'> {
  const key = `digest-${date}`;
  const { outcome } = await database.command(
    { name: 'digest.send', idempotencyKey: key, correlationId: key },
    async (scope) => {
      // Delivered inside the command: a failed delivery stores nothing and can be retried.
      const daily = await buildDigest(
        {
          ...scope,
          access: database.access,
          aiCalls: database.aiCalls,
          agentRuns: database.agentRuns,
        },
        nowMs,
      );
      await deliver(`${await weeklyReviewText(database, nowMs)}\n\n${daily}`);
      if (deliverCard !== undefined) {
        for (const proposal of await weeklyProposals(database, nowMs)) {
          await deliverCard(proposal.text, proposal.keyboard);
        }
      }
      return { sentAt: toTimestamp(new Date(nowMs)) };
    },
  );
  return outcome === 'executed' ? 'sent' : 'already_sent';
}
