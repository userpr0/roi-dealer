import type { Database } from '@roi-dealer/database';
import {
  integrationActor,
  SOURCE_CATALOG,
  type CatalogEntry,
  type CatalogVerdict,
} from '@roi-dealer/evidence';
import { ACCESS_LABELS } from './agents.js';

const VERDICT_TITLES: Readonly<Record<CatalogVerdict, string>> = {
  allowed: '✅ Разрешены',
  needs_agreement: '🤝 Нужен договор или одобрение',
  needs_review: '🔎 Ждут проверки условий',
  rejected: '⛔ Отклонены',
};
const VERDICT_ORDER: readonly CatalogVerdict[] = [
  'allowed',
  'needs_agreement',
  'needs_review',
  'rejected',
];
const NOT_CONNECTED = 'ещё не подключён';

/** `2026-10-20` → `20.10.2026`. */
function formatDate(isoDate: string): string {
  return isoDate.split('-').reverse().join('.');
}

/**
 * /sources (D-026): every source in the catalog — the scout's archive — grouped by verdict; for
 * allowed sources, whether their integration may collect. From the catalog and the database only.
 */
export async function sourcesText(
  database: Pick<Database, 'repositories'>,
  catalog: readonly CatalogEntry[] = SOURCE_CATALOG,
): Promise<string> {
  const lastCheck = catalog.reduce(
    (last, entry) => (entry.review.checkedOn > last ? entry.review.checkedOn : last),
    '',
  );
  const lines = [
    `📚 Источники в каталоге: ${String(catalog.length)}, последняя проверка ${formatDate(lastCheck)}`,
  ];
  for (const verdict of VERDICT_ORDER) {
    const entries = catalog.filter((entry) => entry.review.verdict === verdict);
    if (entries.length === 0) continue;
    lines.push('', `${VERDICT_TITLES[verdict]} — ${String(entries.length)}`);
    if (verdict !== 'allowed') {
      lines.push(entries.map((entry) => entry.name).join(', '));
      continue;
    }
    for (const entry of entries) {
      const principal = await database.repositories.principals.getByActor(integrationActor(entry));
      lines.push(
        `• ${entry.name} — ${principal === undefined ? NOT_CONNECTED : ACCESS_LABELS[principal.status]}`,
      );
    }
  }
  lines.push(
    '',
    'Разведчик проверяет условия по понедельникам: ждущие проверки — каждый раз, остальные — раз в ' +
      'полгода. Новый источник сначала попросит доступ в /decisions.',
  );
  return lines.join('\n');
}
