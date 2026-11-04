import { formatUsd } from '@roi-dealer/domain';
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

function monthTitle(month: string): string {
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

/** /roi — the current month so far; `/roi прошлый` — the previous full month. */
export async function roiText(
  database: Pick<Database, 'economics'>,
  nowMs: number,
  args: string,
): Promise<string> {
  const which = PREVIOUS.has(args.trim().toLowerCase()) ? 'previous' : 'current';
  return roiReportText(await processReport(database, nowMs, which));
}

/** On the first day of a UTC month the digest points to the report of the month just closed. */
export function roiDigestLine(nowMs: number): string | undefined {
  return new Date(nowMs).getUTCDate() === 1
    ? '📊 Месяц закрыт: ROI процессов → /roi прошлый'
    : undefined;
}
