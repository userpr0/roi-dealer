import {
  MONTHLY_LIMITS,
  startOfUtcMonth,
  sumMoney,
  toTimestamp,
  usd,
  ZERO_USD,
  type CostCategory,
  type Money,
} from '@roi-dealer/domain';
import type { Database, ProcessOutputs } from '@roi-dealer/database';
import { aiCents } from './report.js';

/*
 * ROI of the processes (16b, ADR-0011, D-030): once a month, what each process of the cycle cost
 * — from the ledgers and the AI call journal — against what it produced, and a verdict computed
 * here in code (§2.13): keep, scale, review, or too early to tell. The owner decides; the report
 * only recommends. Nothing is estimated.
 */

export type ProcessOutputKey = Exclude<keyof ProcessOutputs, 'aiByTask' | 'aiEvalMicroUsd'>;

export interface ProcessDefinition {
  readonly key: string;
  readonly title: string;
  /** AI tasks whose calls are this process's cost. */
  readonly aiTasks: readonly string[];
  /** Ledger categories that are this process's cost. */
  readonly categories: readonly CostCategory[];
  /** The result that justifies the cost; absent for shared costs. */
  readonly output?: { readonly metric: ProcessOutputKey; readonly label: string };
  /** Revenue of the period is weighed against this process (the tests). */
  readonly earns?: boolean;
  /** The golden-set evals: quality, not production. */
  readonly evals?: boolean;
  /** AI tasks no process names land here, so no money goes unaccounted. */
  readonly otherAi?: boolean;
}

/** The processes of the cycle, in its order. */
export const PROCESSES: readonly ProcessDefinition[] = [
  {
    key: 'pains',
    title: 'Поиск болей',
    aiTasks: ['extract-signal', 'match-pain', 'redact-names', 'research-query'],
    categories: [],
    output: { metric: 'painsValidated', label: 'подтверждённые боли' },
  },
  {
    key: 'opportunities',
    title: 'Оценка возможностей',
    aiTasks: ['frame-opportunity', 'market-context', 'judge-opportunity'],
    categories: [],
    output: { metric: 'opportunitiesApproved', label: 'возможности, одобренные вами' },
  },
  {
    key: 'preparation',
    title: 'Гипотезы и лендинги',
    aiTasks: ['design-hypotheses', 'write-landing'],
    categories: ['media'],
    output: { metric: 'landingsApproved', label: 'одобренные лендинги' },
  },
  {
    key: 'tests',
    title: 'Тесты: трафик',
    aiTasks: [],
    categories: ['ads'],
    output: { metric: 'leads', label: 'заявки' },
    earns: true,
  },
  { key: 'quality', title: 'Проверка качества AI', aiTasks: [], categories: [], evals: true },
  {
    key: 'platform',
    title: 'Платформа',
    aiTasks: [],
    categories: ['infrastructure', 'storage', 'api', 'vendor', 'human', 'other'],
    otherAi: true,
  },
];

/** Below this a process has spent too little to judge. */
export const PROCESS_MIN_COST = usd(100);

export const PROCESS_VERDICTS = [
  'keep',
  'scale',
  'review',
  'over_limit',
  'shared',
  'early',
] as const;
export type ProcessVerdict = (typeof PROCESS_VERDICTS)[number];

export interface ProcessLine {
  readonly key: string;
  readonly title: string;
  readonly cost: Money;
  readonly output?: { readonly label: string; readonly count: number };
  /** Cost of one result; absent without results. */
  readonly unitCost?: Money;
  /** Revenue weighed against the process (the tests). */
  readonly revenue?: Money;
  readonly verdict: ProcessVerdict;
}

export interface ProcessRoiInput {
  /** Costs of the period by ledger category (`ai` and `refund` are ignored: see below). */
  readonly costs: ReadonlyMap<CostCategory, Money>;
  readonly outputs: ProcessOutputs;
  /** Payments and preorders of the period. */
  readonly revenue: Money;
}

function verdictOf(
  definition: ProcessDefinition,
  cost: Money,
  count: number | undefined,
  revenue: Money,
  costs: ReadonlyMap<CostCategory, Money>,
): ProcessVerdict {
  if (definition.otherAi === true) {
    const limit = MONTHLY_LIMITS.infrastructure;
    const infrastructure = costs.get('infrastructure') ?? ZERO_USD;
    return limit !== undefined && infrastructure.amountCents > limit.amountCents
      ? 'over_limit'
      : 'shared';
  }
  if (definition.output === undefined) return 'shared';
  if (cost.amountCents < PROCESS_MIN_COST.amountCents) return 'early';
  if (definition.earns === true && revenue.amountCents >= cost.amountCents) return 'scale';
  if ((count ?? 0) === 0 && (definition.earns !== true || revenue.amountCents === 0)) {
    return 'review';
  }
  return 'keep';
}

/**
 * Each process's cost against its result, and a verdict. AI costs come from the call journal
 * (the daily `ai` ledger entries repeat it); refunds reduce revenue, not cost.
 */
export function processRoi(input: ProcessRoiInput): ProcessLine[] {
  const named = new Set(PROCESSES.flatMap((definition) => definition.aiTasks));
  const otherAiMicro = [...input.outputs.aiByTask.entries()]
    .filter(([task]) => !named.has(task))
    .reduce((sum, [, micro]) => sum + micro, 0);

  return PROCESSES.map((definition) => {
    let aiMicro = definition.aiTasks.reduce(
      (sum, task) => sum + (input.outputs.aiByTask.get(task) ?? 0),
      0,
    );
    if (definition.evals === true) aiMicro += input.outputs.aiEvalMicroUsd;
    if (definition.otherAi === true) aiMicro += otherAiMicro;
    const cost = sumMoney([
      aiCents(aiMicro),
      ...definition.categories.map((category) => input.costs.get(category) ?? ZERO_USD),
    ]);
    const count =
      definition.output === undefined ? undefined : input.outputs[definition.output.metric];
    const revenue = definition.earns === true ? input.revenue : ZERO_USD;
    return {
      key: definition.key,
      title: definition.title,
      cost,
      ...(definition.output === undefined || count === undefined
        ? {}
        : { output: { label: definition.output.label, count } }),
      ...(count !== undefined && count > 0 && cost.amountCents > 0
        ? { unitCost: usd(Math.round(cost.amountCents / count)) }
        : {}),
      ...(definition.earns === true ? { revenue } : {}),
      verdict: verdictOf(definition, cost, count, revenue, input.costs),
    };
  });
}

export interface ProcessReport {
  /** `YYYY-MM` of the UTC month. */
  readonly month: string;
  /** Whether the month is over. */
  readonly complete: boolean;
  readonly lines: readonly ProcessLine[];
  readonly totalCost: Money;
  readonly revenue: Money;
  /** Revenue ÷ all costs, percent; absent without costs. */
  readonly roiPercent?: number;
}

/** The UTC month that contains `nowMs`, or the one before it. */
function monthBounds(nowMs: number, which: 'current' | 'previous') {
  const start = startOfUtcMonth(nowMs);
  if (which === 'current') return { from: start, to: nowMs + 1, complete: false };
  const previous = startOfUtcMonth(start - 1);
  return { from: previous, to: start, complete: true };
}

/** The process report of the current month so far, or of the previous full month. */
export async function processReport(
  database: Pick<Database, 'economics'>,
  nowMs: number,
  which: 'current' | 'previous' = 'current',
): Promise<ProcessReport> {
  const bounds = monthBounds(nowMs, which);
  const period = {
    from: toTimestamp(new Date(bounds.from)),
    to: toTimestamp(new Date(bounds.to)),
  };
  const [costs, revenue, outputs] = await Promise.all([
    database.economics.costsByCategory(period),
    database.economics.revenue(period),
    database.economics.processOutputs(period),
  ]);
  const received = usd(revenue.payments.amountCents + revenue.preorders.amountCents);
  const lines = processRoi({ costs, outputs, revenue: received });
  const totalCost = sumMoney(lines.map((line) => line.cost));
  return {
    month: new Date(bounds.from).toISOString().slice(0, 7),
    complete: bounds.complete,
    lines,
    totalCost,
    revenue: received,
    ...(totalCost.amountCents > 0
      ? { roiPercent: Math.round((received.amountCents / totalCost.amountCents) * 100) }
      : {}),
  };
}
