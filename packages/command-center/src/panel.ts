import {
  experimentDay,
  metricReached,
  metricValue,
  toTimestamp,
  unitEconomics,
  type Actor,
} from '@roi-dealer/domain';
import type { CycleCounts, Database } from '@roi-dealer/database';
import { monthReport } from '@roi-dealer/economics';
import { verifyInitData, type InitDataRejection } from '@roi-dealer/telegram';
import { decidableRequests } from './approvals.js';
import { COST_LABELS } from './economics.js';
import {
  activeExperimentViews,
  EXPERIMENT_STATUS_LABELS,
  METHOD_LABELS,
  metricText,
} from './experiments.js';
import { loadAutomationControl } from './kill-switch.js';
import { reviewCount } from './opportunity-cards.js';
import { STATS_DAYS } from './stats.js';

/*
 * The Mini App's data (PHASE 13, ADR-0008): a read-only snapshot of the panel for the owner —
 * the same numbers and labels as in the bot, from the database (§7.3) — and the check of the
 * Telegram signature that guards it. Money is in cents (USD) and AI in micro-USD, as stored.
 */

const DAY_MS = 86_400_000;

export interface PanelCycle {
  readonly evidence: number;
  readonly signals: number;
  readonly pains: number;
  readonly painsValidated: number;
  readonly opportunities: number;
  readonly opportunitiesUnderReview: number;
  readonly opportunitiesInWork: number;
  readonly hypotheses: number;
  readonly experimentsStarted: number;
  readonly experimentsCompleted: number;
  readonly customers: number;
  readonly revenueCents: number;
}

export interface PanelSnapshot {
  readonly generatedAt: string;
  readonly killSwitch: { readonly running: boolean; readonly reason?: string | undefined };
  readonly decisions: { readonly requests: number; readonly opportunities: number };
  readonly economics: {
    readonly month: string;
    readonly totalCostsCents: number;
    readonly budgets: readonly {
      readonly label: string;
      readonly spentCents: number;
      readonly limitCents: number;
      readonly state: string;
    }[];
    readonly aiTodayMicroUsd: number;
    readonly aiAllowanceMicroUsd: number;
    readonly tests: {
      readonly active: number;
      readonly approvedCents: number;
      readonly spentCents: number;
    };
    readonly paymentsCents: number;
    readonly preordersCents: number;
    readonly refundsCents: number;
    readonly customers: number;
    readonly roiPercent?: number | undefined;
    readonly costPerTestedHypothesisCents?: number | undefined;
  };
  readonly experiments: readonly {
    readonly number: number;
    readonly title: string;
    readonly method: string;
    readonly status: string;
    readonly day?: number | undefined;
    readonly days: number;
    readonly overdue: boolean;
    readonly metric: string;
    readonly value?: number | undefined;
    readonly reached: boolean;
    readonly spentCents: number;
    readonly budgetCents: number;
    readonly stopLossCents: number;
    readonly revenueCents: number;
    readonly customers: number;
    readonly roiPercent?: number | undefined;
  }[];
  readonly stats: {
    readonly days: number;
    readonly recent: PanelCycle;
    readonly allTime: PanelCycle;
    readonly decisionLatencyDays?: number | undefined;
    readonly newKnowledge: number;
  };
}

function cycle(counts: CycleCounts): PanelCycle {
  const { revenue, ...rest } = counts;
  return { ...rest, revenueCents: revenue.amountCents };
}

/** The panel for the Mini App, read-only, from the database. */
export async function panelSnapshot(database: Database, nowMs: number): Promise<PanelSnapshot> {
  const at = toTimestamp(new Date(nowMs));
  const period = {
    from: toTimestamp(new Date(nowMs - STATS_DAYS * DAY_MS)),
    to: toTimestamp(new Date(nowMs + 1)),
  };
  const [control, requests, review, month, views, recent, allTime, latency, knowledge] =
    await Promise.all([
      loadAutomationControl(database.repositories),
      decidableRequests(database.repositories, at),
      reviewCount(database.repositories),
      monthReport(database, nowMs),
      activeExperimentViews(database),
      database.stats.cycle(period.from),
      database.stats.cycle(),
      database.stats.decisionLatencyDays(period),
      database.stats.newKnowledge(period),
    ]);
  return {
    generatedAt: at,
    killSwitch: { running: control.status === 'running', reason: control.reason },
    decisions: { requests: requests.length, opportunities: review },
    economics: {
      month: month.month,
      totalCostsCents: month.totalCosts.amountCents,
      budgets: month.budgets.map((line) => ({
        label: COST_LABELS[line.category],
        spentCents: line.spent.amountCents,
        limitCents: line.limit.amountCents,
        state: line.state,
      })),
      aiTodayMicroUsd: month.ai.todayMicroUsd,
      aiAllowanceMicroUsd: month.ai.allowanceMicroUsd,
      tests: {
        active: month.tests.active,
        approvedCents: month.tests.approved.amountCents,
        spentCents: month.tests.spent.amountCents,
      },
      paymentsCents: month.revenue.payments.amountCents,
      preordersCents: month.revenue.preorders.amountCents,
      refundsCents: month.refunds.amountCents,
      customers: month.revenue.customers,
      roiPercent: month.roiPercent,
      costPerTestedHypothesisCents: month.costPerTestedHypothesis?.amountCents,
    },
    experiments: views.map((view) => {
      const { experiment } = view;
      const metric = experiment.successMetric;
      const value = metricValue(metric, view.totals);
      const day = experimentDay(experiment, at);
      return {
        number: view.number,
        title: view.opportunity.title,
        method: METHOD_LABELS[view.hypothesis.validationMethod],
        status: EXPERIMENT_STATUS_LABELS[experiment.status],
        day: day?.day,
        days: experiment.buildBudget.maxCalendarDays,
        overdue: day?.overdue === true && experiment.status === 'running',
        metric: metricText(metric),
        value,
        reached: metricReached(metric, value),
        spentCents: view.spent.amountCents,
        budgetCents: experiment.testBudget.amountCents,
        stopLossCents: experiment.stopLoss.amountCents,
        revenueCents: view.money.payments.amountCents + view.money.preorders.amountCents,
        customers: view.money.customers,
        roiPercent: unitEconomics(view.money).roiPercent,
      };
    }),
    stats: {
      days: STATS_DAYS,
      recent: cycle(recent),
      allTime: cycle(allTime),
      decisionLatencyDays: latency,
      newKnowledge: knowledge,
    },
  };
}

export type PanelAccess =
  | { readonly status: 200; readonly actor: Actor }
  | { readonly status: 401; readonly reason: InitDataRejection }
  | { readonly status: 403; readonly userId: number };

/**
 * Who may read the panel: a fresh `initData` signed for this bot (ADR-0008) by the owner's
 * Telegram account. The header is `Authorization: tma <initData>`.
 */
export function authorizePanel(
  authorization: string | undefined,
  options: { readonly botToken: string; readonly ownerUserId: number; readonly nowMs: number },
): PanelAccess {
  const initData = authorization?.startsWith('tma ') === true ? authorization.slice(4) : undefined;
  const check = verifyInitData(initData, options.botToken, options.nowMs);
  if (!check.ok) return { status: 401, reason: check.reason };
  if (check.userId !== options.ownerUserId) return { status: 403, userId: check.userId };
  return { status: 200, actor: { type: 'owner', id: `telegram:${String(check.userId)}` } };
}
