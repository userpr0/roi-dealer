import {
  formatUsd,
  type Hypothesis,
  type HypothesisStatus,
  type Opportunity,
} from '@roi-dealer/domain';
import type { Repositories } from '@roi-dealer/database';
import { shorten } from './texts.js';

/** At most this many opportunities are listed in /hypotheses. */
export const HYPOTHESES_SHOWN = 5;

const METHOD_LABELS: Readonly<Record<Hypothesis['validationMethod'], string>> = {
  landing_page: 'лендинг',
  demo: 'демо',
  clickable_prototype: 'прототип',
  concierge: 'вручную (concierge)',
  preorder: 'предзаказ',
  ads_test: 'реклама',
  outreach: 'прямые сообщения',
  interviews: 'интервью',
  marketplace_listing: 'маркетплейс',
  waitlist: 'лист ожидания',
  other: 'другое',
};
const STATUS_LABELS: Readonly<Record<HypothesisStatus, string>> = {
  proposed: 'предложена',
  selected: 'выбрана',
  discarded: 'отброшена',
  testing: 'проверяется',
  confirmed: 'подтверждена',
  refuted: 'опровергнута',
  inconclusive: 'без вывода',
};

export const NO_HYPOTHESES_TEXT =
  '🧪 Гипотез пока нет.\n\nОни появляются, когда вы одобряете возможность (✅ Проверять в ' +
  '/decisions): агент гипотез предлагает пять разных способов её проверить.';

function hypothesisLines(hypothesis: Hypothesis, index: number): string[] {
  const metric = hypothesis.successMetric;
  return [
    `${String(index + 1)}. ${METHOD_LABELS[hypothesis.validationMethod]} · ${shorten(hypothesis.audience, 80)} (${hypothesis.geo}) · ${formatUsd(hypothesis.price)} · канал: ${shorten(hypothesis.channel, 60)}` +
      (hypothesis.status === 'proposed' ? '' : ` · ${STATUS_LABELS[hypothesis.status]}`),
    `   Бюджет ${formatUsd(hypothesis.budget)}, stop-loss ${formatUsd(hypothesis.stopLoss)} · успех: ${shorten(metric.name, 60)} ${metric.direction === 'at_least' ? '≥' : '≤'} ${String(metric.target)} ${shorten(metric.unit, 20)}`,
    `   ${shorten(hypothesis.statement, 240)}`,
  ];
}

/**
 * /hypotheses (PHASE 14): approved opportunities and their five hypotheses — method, audience
 * and GEO, price, channel, budget and stop-loss, success metric. From the database only.
 */
export async function hypothesesText(
  repositories: Pick<Repositories, 'opportunities' | 'hypotheses'>,
): Promise<string> {
  const open: Opportunity[] = [];
  for (const status of ['approved', 'validating'] as const) {
    open.push(...(await repositories.opportunities.listByStatus(status, { limit: 1_000 })));
  }
  const shown = [...open]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, HYPOTHESES_SHOWN);
  const hypotheses = await repositories.hypotheses.listByOpportunities(
    shown.map((item) => item.id),
  );
  if (hypotheses.length === 0) return NO_HYPOTHESES_TEXT;

  const lines = [`🧪 Гипотезы · возможностей: ${String(shown.length)}`];
  for (const opportunity of shown) {
    const own = hypotheses.filter((item) => item.opportunityId === opportunity.id);
    lines.push(
      '',
      `«${opportunity.title}» — ${own.length === 0 ? 'гипотезы готовятся' : `гипотез ${String(own.length)}`}`,
    );
    for (const [index, hypothesis] of own.entries())
      lines.push(...hypothesisLines(hypothesis, index));
  }
  lines.push('', 'Запуск эксперимента по гипотезе — с вашего одобрения (PHASE 15).');
  return lines.join('\n');
}

/** The one notice per opportunity that its hypotheses are ready. */
export function hypothesesReadyText(opportunity: Opportunity, count: number): string {
  return `🧪 Готовы ${String(count)} гипотез проверки для «${opportunity.title}» → /hypotheses`;
}
