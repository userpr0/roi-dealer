import { distinctSources, type Pain } from '@roi-dealer/domain';
import type { Repositories } from '@roi-dealer/database';

/** At most this many pains are listed in /pains. */
export const PAINS_SHOWN = 10;

const STATUS_LABELS: Readonly<Record<'candidate' | 'validated', string>> = {
  candidate: 'кандидат',
  validated: '✅ подтверждена',
};
const FREQUENCY_LABELS: Readonly<Record<Pain['frequency'], string>> = {
  rare: 'редко',
  occasional: 'иногда',
  frequent: 'часто',
  constant: 'постоянно',
};

export const NO_PAINS_TEXT =
  '🧩 Болей пока не найдено.\n\nАгент болей и сигналов разбирает новые доказательства, когда в ' +
  'worker есть ключи AI и его доступ одобрен в /decisions.';

/**
 * /pains (PHASE 06): the open pains with the most signals first — how often they were seen, from
 * how many sources, how strong. From the database only (§2.13).
 */
export async function painsText(
  repositories: Pick<Repositories, 'pains' | 'evidence'>,
): Promise<string> {
  const open: Pain[] = [];
  for (const status of ['validated', 'candidate'] as const) {
    open.push(...(await repositories.pains.listByStatus(status, { limit: 1_000 })));
  }
  if (open.length === 0) return NO_PAINS_TEXT;

  const top = open
    .sort(
      (a, b) =>
        b.signalIds.length - a.signalIds.length ||
        b.severity - a.severity ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, PAINS_SHOWN);
  const lines = [
    `🧩 Боли · открытых: ${String(open.length)}` +
      (open.length > PAINS_SHOWN
        ? ` · показаны ${String(PAINS_SHOWN)} с наибольшим числом сигналов`
        : ''),
    '',
  ];
  for (const [index, pain] of top.entries()) {
    const sources = distinctSources(await repositories.evidence.getByIds(pain.evidenceIds)).size;
    const status = pain.status === 'validated' ? 'validated' : 'candidate';
    lines.push(
      `${String(index + 1)}. ${pain.title}`,
      `   Кто: ${pain.audience}`,
      `   Сигналов ${String(pain.signalIds.length)} · источников ${String(sources)} · ` +
        `${STATUS_LABELS[status]} · ${FREQUENCY_LABELS[pain.frequency]} · тяжесть ${String(pain.severity)}/5`,
    );
  }
  return lines.join('\n');
}
