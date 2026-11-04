import type { Actor, OpportunityId } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import { shorten } from './texts.js';

/*
 * /audience (phase 28, ADR-0013): the own audience — people who ticked the separate box for
 * topic emails on a test page — per topic. Numbers only: emails are never shown. Sending needs
 * the double opt-in email, and the email service is a separate ADR.
 */

export async function audienceText(
  database: Pick<Database, 'leadContacts' | 'repositories'>,
  owner: Actor,
): Promise<string> {
  const counts = await database.leadContacts.audience(owner);
  if (counts.length === 0) {
    return [
      '📬 Своя аудитория: подписчиков пока нет.',
      'На страницах тестов — отдельная галочка «письма по теме». Рассылка — после выбора сервиса писем (отдельный ADR).',
    ].join('\n');
  }
  const opportunities = await database.repositories.opportunities.getByIds(
    counts.map((item) => item.opportunityId),
  );
  const title = new Map<OpportunityId, string>(opportunities.map((item) => [item.id, item.title]));
  const total = counts.reduce((sum, item) => sum + item.subscribers, 0);
  const confirmed = counts.reduce((sum, item) => sum + item.confirmed, 0);
  return [
    `📬 Своя аудитория: ${String(total)} подписчиков · подтвердили ${String(confirmed)}`,
    ...counts
      .slice(0, 10)
      .map(
        (item) =>
          `• «${shorten(title.get(item.opportunityId) ?? '—', 80)}»: ${String(item.subscribers)}`,
      ),
    'Подтверждение по почте и письма — после выбора сервиса писем (отдельный ADR, ADR-0013).',
    'Удалить почту человека — /forget.',
  ].join('\n');
}
