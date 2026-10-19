import { randomBytes } from 'node:crypto';
import {
  answerQuestion,
  ownerNote,
  MAX_NOTE_LENGTH,
  searchBrain,
  type BrainSearchResult,
  type PeriodKey,
  type QuestionAnswer,
} from '@roi-dealer/brain';
import {
  createKnowledgeAsset,
  knowledgeAssetIdSchema,
  timestampMs,
  type Actor,
  type NewKnowledgeAsset,
  type Timestamp,
} from '@roi-dealer/domain';
import type { CountedEntity, Database, SearchType } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboard,
} from '@roi-dealer/telegram';
import { formatMicroUsd } from './ai-status.js';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';
import { formatTime } from './texts.js';

/** Buttons of /note: `nt:y:<nonce>` stores the note, `nt:n:<nonce>` cancels. */
export const NOTE_PREFIX = 'nt';
const MAX_PENDING = 20;

const TYPE_LABELS: Readonly<Record<SearchType, string>> = {
  pain: '🧩 Боль',
  opportunity: '💡 Возможность',
  evidence: '📚 Доказательство',
  knowledge: '📝 Знание',
  decision: '⚖️ Решение',
};
const PERIOD_LABELS: Readonly<Record<PeriodKey, string>> = {
  day: 'последние 24 часа',
  yesterday: 'вчера (24–48 часов назад)',
  week: 'последние 7 дней',
  month: 'последние 30 дней',
  all: 'всё время',
};
const ENTITY_LABELS: Readonly<Record<CountedEntity, readonly [plural: string, source: string]>> = {
  pain: ['Болей', 'таблица pains → /pains'],
  opportunity: ['Возможностей', 'таблица opportunities → /opportunities'],
  signal: ['Сигналов', 'таблица signals → /journal'],
  evidence: ['Доказательств', 'таблица evidence → /journal'],
  knowledge: ['Знаний', 'таблица knowledge_assets → /search'],
  decision: ['Решений', 'таблица decisions → /history'],
};
const STATUS_LABELS: Readonly<Record<string, string>> = {
  candidate: 'кандидат',
  validated: 'подтверждена',
  rejected: 'отклонена',
  archived: 'в архиве',
  draft: 'черновик',
  under_review: 'на рассмотрении',
  approved: 'одобрена',
  validating: 'проверяется',
  paused: 'на паузе',
  scaling: 'масштабируется',
  killed: 'закрыта',
  new: 'новый',
  triaged: 'разобран',
  promoted: 'продвинут',
  dismissed: 'отклонён',
};

export const SEARCH_USAGE =
  '🔎 Поиск по базе: /search <слова>\nНапример: /search invoices late payments\n\n' +
  'Ищет в болях, возможностях, доказательствах, знаниях и решениях. Данные — на английском.';
export const ASK_USAGE = [
  '❓ Спросите систему: /ask <вопрос>. Ответ — только из базы, с источником.',
  '',
  'Например:',
  '/ask сколько потратили за неделю?',
  '/ask сколько ушло на AI за месяц?',
  '/ask сколько болей?',
  '/ask что нового за день?',
  '',
  'Другие вопросы — поиск по словам вопроса.',
].join('\n');
export const NOTE_USAGE =
  '📝 Записать знание: /note <текст>\nПервая строка станет заголовком. Найти потом — /search.';

function dollars(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** The search result as a message: kind, title, fragment and date of each record. */
export function searchResultText(query: string, result: BrainSearchResult): string {
  if (result.needsEnglish) {
    return (
      'Данные в базе — на английском (посты и выводы AI). Напишите слова по-английски, ' +
      'например /search invoices, или задайте вопрос: /ask сколько болей?'
    );
  }
  if (result.hits.length === 0) {
    return `🔎 «${query}»: ничего не найдено. Попробуйте другие английские слова.`;
  }
  const lines = [
    `🔎 «${query}»` +
      (result.similar
        ? ' — точных совпадений нет, похожие записи:'
        : ` · найдено: ${String(result.hits.length)}`),
    '',
  ];
  for (const [index, hit] of result.hits.entries()) {
    lines.push(
      `${String(index + 1)}. ${TYPE_LABELS[hit.type]} · ${hit.title} · ${formatTime(hit.createdAt)}`,
      `   ${hit.snippet.replace(/\s+/g, ' ').trim()}`,
    );
  }
  return lines.join('\n');
}

function statusLine(byStatus: Readonly<Record<string, number>> | undefined): string[] {
  if (byStatus === undefined || Object.keys(byStatus).length === 0) return [];
  const parts = Object.entries(byStatus)
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => `${STATUS_LABELS[status] ?? status} ${String(count)}`);
  return [`Сейчас: ${parts.join(' · ')}`];
}

/** The facts of an answer as a message, always with their source (§7.3). */
export function answerText(question: string, answer: QuestionAnswer): string {
  switch (answer.kind) {
    case 'spend': {
      const categories = Object.entries(answer.byCategory)
        .sort(([, a], [, b]) => b - a)
        .map(([category, cents]) => `${category} ${dollars(cents)}`);
      return [
        `💸 Расходы за ${PERIOD_LABELS[answer.period]}: ${dollars(answer.totalCents)} · записей ${String(answer.entries)}`,
        ...(categories.length === 0 ? [] : [`По категориям: ${categories.join(' · ')}`]),
        'Источник: журнал расходов (cost_entries, сторно вычтены) → /history',
      ].join('\n');
    }
    case 'ai_spend':
      return [
        `🤖 AI за ${PERIOD_LABELS[answer.period]}: ${formatMicroUsd(answer.costMicroUsd)} · вызовов ${String(answer.calls)}` +
          (answer.failed === 0 ? '' : `, с ошибкой ${String(answer.failed)}`),
        'Источник: журнал вызовов AI (ai_calls) → /status',
      ].join('\n');
    case 'count': {
      const [plural, source] = ENTITY_LABELS[answer.entity];
      return [
        `${plural} создано за ${PERIOD_LABELS[answer.period]}: ${String(answer.created)}`,
        ...statusLine(answer.byStatus),
        `Источник: ${source}`,
      ].join('\n');
    }
    case 'news': {
      const parts = (Object.entries(answer.created) as [CountedEntity, number][]).map(
        ([entity, count]) => `${ENTITY_LABELS[entity][0].toLowerCase()} ${String(count)}`,
      );
      return [
        `🆕 Создано за ${PERIOD_LABELS[answer.period]}: ${parts.join(' · ')}`,
        'Источник: таблицы БД → /journal',
      ].join('\n');
    }
    case 'search':
      return [
        'Такого вопроса нет среди готовых ответов — вот что нашлось в базе по его словам.',
        '',
        searchResultText(question, answer),
        '',
        '/ask без текста — какие вопросы понимает система.',
      ].join('\n');
  }
}

export async function searchReply(database: Database, query: string): Promise<string> {
  const text = query.replace(/\s+/g, ' ').trim();
  if (text === '') return SEARCH_USAGE;
  return searchResultText(text, await searchBrain(database, text));
}

export async function askReply(
  database: Database,
  question: string,
  nowMs: number,
): Promise<string> {
  const text = question.replace(/\s+/g, ' ').trim();
  if (text === '') return ASK_USAGE;
  return answerText(text, await answerQuestion(database, text, nowMs));
}

export interface NoteFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

export interface NoteFlow {
  readonly note: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

interface PendingNote {
  readonly data: NewKnowledgeAsset;
  readonly expiresAtMs: number;
}

/**
 * /note writes to the database, so it asks for confirmation first; the note (too long for
 * button data) waits in memory for 10 minutes. The write is an idempotent command of the owner.
 */
export function createNoteFlow(deps: NoteFlowDeps): NoteFlow {
  const pending = new Map<string, PendingNote>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(data: NewKnowledgeAsset): string {
    const current = nowMs();
    for (const [nonce, entry] of pending) {
      if (entry.expiresAtMs <= current) pending.delete(nonce);
    }
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const nonce = randomBytes(8).toString('hex');
    pending.set(nonce, { data, expiresAtMs: current + CONFIRMATION_TTL_MS });
    return nonce;
  }

  return {
    async note(context) {
      const data = ownerNote(context.args);
      if (data === 'empty') {
        await context.reply(NOTE_USAGE);
        return;
      }
      if (data === 'too_long') {
        await context.reply(`Заметка длиннее ${String(MAX_NOTE_LENGTH)} символов. Сократите её.`);
        return;
      }
      const nonce = remember(data);
      const keyboard: InlineKeyboard = [
        [
          callbackButton('📝 Записать', `${NOTE_PREFIX}:y:${nonce}`),
          callbackButton('Отмена', `${NOTE_PREFIX}:n:${nonce}`),
        ],
      ];
      await context.reply(
        `📝 Записать в базу знаний?\n«${data.title}»\n\nПодтверждение действует 10 минут.`,
        keyboard,
      );
    },

    async handleButton(context) {
      const [answer, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (answer === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (answer !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /note.');
        return;
      }
      const actor = deps.owner(context.userId);
      const { outcome, result } = await deps.database.command(
        {
          name: 'knowledge.note',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${context.updateId}`,
        },
        async ({ repositories }) => {
          const asset = createKnowledgeAsset(confirmation.data, {
            id: knowledgeAssetIdSchema.parse(uuidv7()),
            actor,
            at: deps.now(),
          });
          await repositories.knowledgeAssets.insert(asset);
          return { id: asset.id };
        },
      );
      if (nonce !== undefined) pending.delete(nonce);
      context.logger.info('owner note stored', { outcome, knowledge_asset_id: result.id });
      await context.edit(
        `📝 Записано в базу знаний: «${confirmation.data.title}».\nНайти: /search`,
      );
    },
  };
}
