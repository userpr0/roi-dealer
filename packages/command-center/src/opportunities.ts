import type { Opportunity, OpportunityId } from '@roi-dealer/domain';
import type { OpportunityAssessmentLog, Repositories } from '@roi-dealer/database';

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

export const NO_OPPORTUNITIES_TEXT =
  '💡 Возможностей пока нет.\n\nАгент возможностей оценивает боли, которые встретились хотя бы ' +
  'дважды (/pains), когда в worker есть ключи AI и его доступ одобрен в /decisions.';

/**
 * /opportunities (PHASE 07): draft opportunities with the best score first, with the parts of
 * the score, the business model and the pain. From the database only (§2.13).
 */
export async function opportunitiesText(
  repositories: Pick<Repositories, 'opportunities' | 'pains'>,
  assessments: Pick<OpportunityAssessmentLog, 'scores'>,
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
      ...(pain === undefined ? [] : [`   Боль: ${pain.title}`]),
    );
  }
  lines.push('', 'Решение по возможности — карточкой с кнопками после судей (PHASE 11–12).');
  return lines.join('\n');
}
