import {
  changePainStatus,
  distinctSources,
  painIdSchema,
  type Actor,
  type Pain,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database, type Repositories } from '@roi-dealer/database';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';

/** At most this many pains are listed in /pains. */
export const PAINS_SHOWN = 10;
/** Buttons that reject a pain (PHASE 13): `pn:<action>:<pain id>:<version>`. */
export const PAIN_PREFIX = 'pn';

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
  return (await painsReply(repositories)).text;
}

async function topPains(repositories: Pick<Repositories, 'pains'>): Promise<{
  readonly open: number;
  readonly top: Pain[];
}> {
  const open: Pain[] = [];
  for (const status of ['validated', 'candidate'] as const) {
    open.push(...(await repositories.pains.listByStatus(status, { limit: 1_000 })));
  }
  const top = open
    .sort(
      (a, b) =>
        b.signalIds.length - a.signalIds.length ||
        b.severity - a.severity ||
        b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, PAINS_SHOWN);
  return { open: open.length, top };
}

function rejectButton(text: string, action: string, pain: Pain) {
  return callbackButton(text, `${PAIN_PREFIX}:${action}:${pain.id}:${String(pain.version)}`);
}

/** /pains with a ✖️ button per listed pain (PHASE 13), five to a row. */
export async function painsReply(
  repositories: Pick<Repositories, 'pains' | 'evidence'>,
): Promise<{ readonly text: string; readonly keyboard?: InlineKeyboard | undefined }> {
  const { top } = await topPains(repositories);
  const text = await listText(repositories);
  if (top.length === 0) return { text };
  const buttons = top.map((pain, index) => rejectButton(`✖️ ${String(index + 1)}`, 'x', pain));
  const rows: (typeof buttons)[] = [];
  for (let index = 0; index < buttons.length; index += 5)
    rows.push(buttons.slice(index, index + 5));
  return {
    text: `${text}\n\n✖️ N — отклонить боль: агент больше не будет её пополнять.`,
    keyboard: rows,
  };
}

async function listText(repositories: Pick<Repositories, 'pains' | 'evidence'>): Promise<string> {
  const { open, top } = await topPains(repositories);
  if (open === 0) return NO_PAINS_TEXT;
  const lines = [
    `🧩 Боли · открытых: ${String(open)}` +
      (open > PAINS_SHOWN ? ` · показаны ${String(PAINS_SHOWN)} с наибольшим числом сигналов` : ''),
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

export interface PainFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

type RejectOutcome =
  | { readonly outcome: 'rejected'; readonly status: 'rejected' | 'archived' }
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'not_found' };

/**
 * ✖️ under /pains (PHASE 13): ask → confirm → one owner command. A candidate becomes `rejected`,
 * a validated pain `archived` (its lifecycle); the pain agent only adds signals to open pains.
 */
export async function handlePainButton(
  deps: PainFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [action, rawId, rawVersion] = context.data.split(':');
  const id = painIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (!['x', 'yx', 'c'].includes(action ?? '') || !id.success || !Number.isSafeInteger(version)) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { repositories } = deps.database;
  const list = async (note?: string) => {
    const reply = await painsReply(repositories);
    await context.edit(
      note === undefined ? reply.text : `${reply.text}\n\n${note}`,
      reply.keyboard,
    );
  };
  if (action === 'c') {
    await list();
    return;
  }
  if (action === 'x') {
    const pain = await repositories.pains.getById(id.data);
    if (
      pain === undefined ||
      pain.version !== version ||
      !['candidate', 'validated'].includes(pain.status)
    ) {
      await list('⚠️ Список устарел — вот текущий.');
      return;
    }
    await context.edit(
      `🧩 «${pain.title}»\nКто: ${pain.audience}\n\n❓ Отклонить эту боль? Агент больше не будет её пополнять, ` +
        'возможности по ней не появятся.',
      [[rejectButton('✖️ Да, отклонить', 'yx', pain), rejectButton('Назад', 'c', pain)]],
    );
    return;
  }

  const actor = deps.owner(context.userId);
  let result: RejectOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'pain.reject',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async (scope): Promise<RejectOutcome> => {
        const pain = await scope.repositories.pains.getById(id.data);
        if (pain === undefined) return { outcome: 'not_found' };
        if (pain.version !== version || !['candidate', 'validated'].includes(pain.status)) {
          return { outcome: 'closed' };
        }
        const status = pain.status === 'candidate' ? 'rejected' : 'archived';
        await scope.repositories.pains.update(
          changePainStatus(pain, status, { actor, at: deps.now() }),
          actor,
        );
        return { outcome: 'rejected', status };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'closed' };
  }
  if (result.outcome !== 'rejected') {
    await list('⚠️ Боль изменилась одновременно с нажатием — вот текущий список.');
    return;
  }
  context.logger.info('pain rejected by the owner', { pain_id: id.data, status: result.status });
  await list(result.status === 'rejected' ? '✖️ Боль отклонена.' : '🗄 Боль убрана в архив.');
  await context.answer('Записано');
}
