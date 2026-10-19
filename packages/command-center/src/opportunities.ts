import {
  judgePanel,
  MARKET_CONTEXT_TAG,
  readMarketContext,
  type JudgeCriterion,
  type MarketContextData,
  type MoneyPeriod,
  type Opportunity,
  type OpportunityId,
} from '@roi-dealer/domain';
import type {
  JudgementLog,
  OpportunityAssessmentLog,
  Repositories,
  StoredJudgement,
} from '@roi-dealer/database';

/** At most this many opportunities are listed in /opportunities. */
export const OPPORTUNITIES_SHOWN = 10;

const MODEL_LABELS: Readonly<Record<Opportunity['businessModel']['model'], string>> = {
  free_limit: 'бесплатный лимит',
  subscription: 'подписка',
  one_time: 'разовая покупка',
  setup_fee: 'плата за внедрение',
  bundle: 'пакет',
  usage_based: 'оплата за использование',
  outcome_based: 'оплата за результат',
  lifetime_deal: 'пожизненный доступ',
  service: 'услуга',
  marketplace: 'маркетплейс',
  affiliate: 'партнёрская',
  advertising: 'реклама',
  licensing: 'лицензия',
  other: 'другая',
};
const PART_LABELS: Readonly<Record<string, string>> = {
  frequency: 'частота',
  severity: 'тяжесть',
  sources: 'источники',
  willingness: 'готовность платить',
  market: 'рынок',
  buyer: 'покупатель',
};

/** Short names of the judges' criteria (PHASE 11), in the order of `JUDGE_CRITERIA`. */
export const CRITERION_LABELS: Readonly<Record<JudgeCriterion, string>> = {
  market: 'рынок',
  pain_value: 'боль',
  economics: 'экономика',
  buildability: 'сборка',
  risk: 'риск',
  reuse: 'повтор',
};

/** The judges' line (PHASE 11): the total, every score and the weak spots. */
export function judgesLines(judgements: readonly StoredJudgement[]): string[] {
  const scores: Partial<Record<JudgeCriterion, number>> = {};
  for (const item of judgements) {
    if (item.outcome === 'judged' && item.score !== undefined) scores[item.criterion] = item.score;
  }
  const panel = judgePanel(scores);
  const parts = (Object.keys(CRITERION_LABELS) as JudgeCriterion[]).map(
    (criterion) => `${CRITERION_LABELS[criterion]} ${String(scores[criterion] ?? '—')}`,
  );
  const lines = [
    `   ⚖️ Судьи: ${panel.total === undefined ? 'оценивают' : `${String(panel.total)}/100`} · ${parts.join(' · ')}`,
  ];
  if (panel.weak.length > 0) {
    lines.push(
      `   Слабые места: ${panel.weak.map((criterion) => CRITERION_LABELS[criterion]).join(', ')}`,
    );
  }
  return lines;
}

const PERIOD_SUFFIX: Readonly<Record<MoneyPeriod, string>> = {
  one_time: '',
  hour: '/час',
  week: '/нед',
  month: '/мес',
  year: '/год',
  unknown: '',
};
const MAX_MARKET_ITEMS = 3;

function usd(amount: number): string {
  return Number.isInteger(amount) ? `$${amount.toLocaleString('en-US')}` : `$${amount.toFixed(2)}`;
}

/** One line of the market context (PHASE 10): what people use now, money, who pays. */
export function marketLine(context: MarketContextData): string | undefined {
  const parts: string[] = [];
  const list = (items: readonly string[]) =>
    items.slice(0, MAX_MARKET_ITEMS).join(', ') +
    (items.length > MAX_MARKET_ITEMS ? ` и ещё ${String(items.length - MAX_MARKET_ITEMS)}` : '');
  if (context.alternatives.length > 0) {
    parts.push(`сейчас — ${list(context.alternatives.map((item) => item.name))}`);
  }
  if (context.money.length > 0) {
    parts.push(
      `суммы — ${list(context.money.map((item) => `${usd(item.amountUsd)}${PERIOD_SUFFIX[item.period]}`))}`,
    );
  }
  if (context.buyers.length > 0) {
    parts.push(`платит — ${list(context.buyers.map((item) => item.role))}`);
  }
  return parts.length === 0 ? undefined : `   Рынок: ${parts.join(' · ')}`;
}

export const NO_OPPORTUNITIES_TEXT =
  '💡 Возможностей пока нет.\n\nАгент возможностей оценивает боли, которые встретились хотя бы ' +
  'дважды (/pains), когда в worker есть ключи AI и его доступ одобрен в /decisions.';

/**
 * /opportunities (PHASE 07, 10, 11): open opportunities with the best score first, with the
 * parts of the score, the business model, the judges, the market context and the pain. From the
 * database only (§2.13).
 */
export async function opportunitiesText(
  repositories: Pick<Repositories, 'opportunities' | 'pains' | 'knowledgeAssets'>,
  assessments: Pick<OpportunityAssessmentLog, 'scores'>,
  judgements: Pick<JudgementLog, 'latest'>,
): Promise<string> {
  const open: Opportunity[] = [];
  for (const status of ['draft', 'under_review'] as const) {
    open.push(...(await repositories.opportunities.listByStatus(status, { limit: 1_000 })));
  }
  if (open.length === 0) return NO_OPPORTUNITIES_TEXT;

  const scores = await assessments.scores(open.map((item) => item.id));
  const scoreOf = (id: OpportunityId) => scores.get(id)?.score ?? 0;
  const top = [...open]
    .sort((a, b) => scoreOf(b.id) - scoreOf(a.id) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, OPPORTUNITIES_SHOWN);
  const panels = await judgements.latest(top.map((item) => item.id));
  // Newest first: the first entry of an opportunity is its latest context.
  const markets = new Map<OpportunityId, MarketContextData>();
  const entries = await repositories.knowledgeAssets.listByTags([MARKET_CONTEXT_TAG], {
    opportunityIds: top.map((item) => item.id),
    limit: 1_000,
  });
  for (const entry of entries) {
    const id = entry.links.opportunityId;
    const context = readMarketContext(entry);
    if (id !== undefined && context !== undefined && !markets.has(id)) markets.set(id, context);
  }
  const lines = [
    `💡 Возможности · открытых: ${String(open.length)}` +
      (open.length > OPPORTUNITIES_SHOWN
        ? ` · показаны ${String(OPPORTUNITIES_SHOWN)} с лучшей оценкой`
        : ''),
    '',
  ];
  for (const [index, opportunity] of top.entries()) {
    const score = scores.get(opportunity.id);
    const [painId] = opportunity.painIds;
    const pain = painId === undefined ? undefined : await repositories.pains.getById(painId);
    const market = markets.get(opportunity.id);
    const judged = panels.get(opportunity.id);
    const marketText = market === undefined ? undefined : marketLine(market);
    const parts =
      score === undefined
        ? ''
        : // Stored as jsonb, which does not keep key order: the order of the spec is used.
          Object.entries(PART_LABELS)
            .filter(([part]) => part in score.components)
            .map(([part, label]) => `${label} ${String(score.components[part])}`)
            .join(' · ');
    lines.push(
      `${String(index + 1)}. ${opportunity.title} — ${score === undefined ? '—' : String(score.score)}/100`,
      `   Модель: ${MODEL_LABELS[opportunity.businessModel.model]} · рынки: ${opportunity.markets.join(', ')}` +
        (opportunity.status === 'under_review' ? ' · ждёт решения' : ' · черновик'),
      ...(parts === '' ? [] : [`   Оценка: ${parts}`]),
      ...(judged === undefined ? [] : judgesLines(judged)),
      ...(marketText === undefined ? [] : [marketText]),
      ...(pain === undefined ? [] : [`   Боль: ${pain.title}`]),
    );
  }
  lines.push('', 'Решение по возможности — карточкой с кнопками (PHASE 12).');
  return lines.join('\n');
}
