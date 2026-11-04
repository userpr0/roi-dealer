import {
  calibration,
  COIN_BRIER,
  formatUsd,
  WEIGHTS_PROPOSAL_MIN_OUTCOMES,
  type Calibration,
} from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import {
  processReport,
  type ProcessLine,
  type ProcessReport,
  type ProcessVerdict,
} from '@roi-dealer/economics';

/*
 * /roi (16b): what each process of the cycle cost this month (or last month) against what it
 * produced, with the verdict computed in code. The owner decides what to keep or switch off:
 * agents in /access, everything at once with /stop.
 */

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

const VERDICT_TEXT: Readonly<Record<ProcessVerdict, string>> = {
  keep: '✅ оставить',
  scale: '📈 окупается — масштабировать',
  review: '🔻 тратит без результата — пересмотреть или выключить',
  over_limit: '🔻 выше лимита D-007 — сократить',
  shared: 'ℹ️ общие расходы',
  early: '➖ мало трат — рано судить',
};

/** Words that ask for the previous month: `/roi прошлый`. */
const PREVIOUS = new Set(['прошлый', 'прошлого', 'прошлая', 'last', 'prev', 'previous']);

/** 'YYYY-MM' → «ноябрь 2026». */
export function monthTitle(month: string): string {
  const [year, number] = month.split('-');
  return `${MONTHS[Number(number) - 1] ?? month} ${year ?? ''}`;
}

function line(process: ProcessLine): string {
  const parts = [`• ${process.title}: ${formatUsd(process.cost)}`];
  if (process.output !== undefined) {
    const unit =
      process.unitCost === undefined ? '' : ` (${formatUsd(process.unitCost)} за результат)`;
    parts.push(`${process.output.label}: ${String(process.output.count)}${unit}`);
  }
  if (process.revenue !== undefined && process.revenue.amountCents > 0) {
    parts.push(`выручка ${formatUsd(process.revenue)}`);
  }
  return `${parts.join(' · ')} — ${VERDICT_TEXT[process.verdict]}`;
}

export function roiReportText(report: ProcessReport): string {
  const title = report.complete
    ? `📊 ROI процессов · ${monthTitle(report.month)} (месяц закрыт)`
    : `📊 ROI процессов · ${monthTitle(report.month)} (месяц идёт)`;
  const total =
    report.roiPercent === undefined
      ? `Всего: расходов нет, выручка ${formatUsd(report.revenue)}`
      : `Всего: расходы ${formatUsd(report.totalCost)} · выручка ${formatUsd(report.revenue)} · ROI ${String(report.roiPercent)}%`;
  const review = report.lines.some(
    (item) => item.verdict === 'review' || item.verdict === 'over_limit',
  );
  return [
    title,
    '',
    ...report.lines.map(line),
    '',
    total,
    ...(review ? ['Выключить агентов процесса — /access; всё сразу — /stop. Решаете вы.'] : []),
    report.complete ? '' : 'Прошлый месяц целиком — /roi прошлый',
    'Расходы — из журналов и вызовов AI, результаты — из базы; вердикт считает код.',
  ]
    .filter((item, index, all) => !(item === '' && all[index - 1] === ''))
    .join('\n');
}

const percent = (value: number) => `${String(Math.round(value * 100))}%`;

/**
 * Forecast vs fact (phase 25, ADR-0013): how accurate the forecasts of each version of the rules
 * are, over all time. Numbers come from `calibration` in code.
 */
export function forecastLines(versions: readonly Calibration[]): string[] {
  if (versions.length === 0) {
    return ['🎯 Прогнозы: пока нет — журнал начнётся с первого запущенного теста.'];
  }
  const lines = versions.map((item) => {
    const head = `🎯 Прогнозы (правила v${String(item.rulesVersion)}): тестов ${String(item.forecasts)}, с итогом ${String(item.resolved)}`;
    if (item.brier === undefined || item.expectedRate === undefined) return `${head}.`;
    return (
      `${head}\nОжидали успех в ${percent(item.expectedRate)}, вышло ${percent(item.observedRate ?? 0)} · ` +
      `точность (Brier) ${item.brier.toFixed(2)} — монетка ${COIN_BRIER.toFixed(2)}, меньше — лучше`
    );
  });
  const resolved = versions[0]?.resolved ?? 0;
  return [
    ...lines,
    resolved >= WEIGHTS_PROPOSAL_MIN_OUTCOMES
      ? 'Итогов достаточно для новых весов оценки — их предложение придёт карточкой.'
      : `Новые веса оценки — после ${String(WEIGHTS_PROPOSAL_MIN_OUTCOMES)} итогов (сейчас ${String(resolved)}).`,
  ];
}

/** /roi — the current month so far; `/roi прошлый` — the previous full month. */
export async function roiText(
  database: Pick<Database, 'economics' | 'forecasts'>,
  nowMs: number,
  args: string,
): Promise<string> {
  const which = PREVIOUS.has(args.trim().toLowerCase()) ? 'previous' : 'current';
  const [report, forecasts] = await Promise.all([
    processReport(database, nowMs, which),
    database.forecasts.list(),
  ]);
  return [roiReportText(report), '', ...forecastLines(calibration(forecasts))].join('\n');
}

/** One line of the weekly review once some forecast test has a clear result. */
export async function forecastReviewLine(
  database: Pick<Database, 'forecasts'>,
): Promise<string | undefined> {
  const [latest] = calibration(await database.forecasts.list());
  if (latest?.brier === undefined) return undefined;
  return `🎯 Прогнозы v${String(latest.rulesVersion)}: итогов ${String(latest.resolved)}, точность (Brier) ${latest.brier.toFixed(2)} (монетка ${COIN_BRIER.toFixed(2)}) → /roi`;
}

/** On the first day of a UTC month the digest points to the report of the month just closed. */
export function roiDigestLine(nowMs: number): string | undefined {
  return new Date(nowMs).getUTCDate() === 1
    ? '📊 Месяц закрыт: ROI процессов → /roi прошлый'
    : undefined;
}
