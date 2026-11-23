import { randomBytes } from 'node:crypto';
import {
  libraryPath,
  libraryTopicIdSchema,
  newLibraryNodes,
  timestampMs,
  toTimestamp,
  withLibraryNodes,
  type Actor,
  type LibraryPlace,
  type LibraryTopic,
  type LibraryTopicId,
  type LibraryTree,
  type LibraryVertical,
  type OpportunityId,
  type PainId,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  storeLibraryNodes,
  type Database,
  type LibraryFiling,
  type LibraryObjectType,
} from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboardButton,
} from '@roi-dealer/telegram';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';
import { shorten } from './texts.js';

/*
 * /library (phase 35, ADR-0016): the tree vertical → project → topic and what is filed where.
 * The librarian agent files by itself; the owner moves what went to the wrong place and may add
 * folders. A move is a new row of the filing journal, with confirmation.
 */

export const LIBRARY_PREFIX = 'lib';
export const LIBRARY_USAGE = 'Добавить папки: /library add Вертикаль / Проект / Тема';

type LibraryStore = Pick<Database, 'repositories' | 'library'>;
type Keyboard = (readonly InlineKeyboardButton[])[];

const MAX_BUTTONS = 24;
const SHOWN_OBJECTS = 8;
const MAX_PENDING = 20;
const DAY_MS = 24 * 3_600_000;

const OBJECT_CODES: Readonly<Record<LibraryObjectType, string>> = { pain: 'p', opportunity: 'o' };
const OBJECT_LABELS: Readonly<Record<LibraryObjectType, string>> = {
  pain: 'Боль',
  opportunity: 'Возможность',
};
const objectTypeOf = (code: string | undefined): LibraryObjectType | undefined =>
  code === 'p' ? 'pain' : code === 'o' ? 'opportunity' : undefined;

const REJECTIONS = {
  invalid_name: 'Название — 2–60 знаков: буквы, цифры и простые знаки, без «/» внутри названия.',
  too_many_verticals: 'Вертикалей уже 20 — это предел. Положите в существующую.',
  too_many_projects: 'В этой вертикали уже 50 проектов — это предел.',
  too_many_topics: 'В этом проекте уже 200 тем — это предел.',
} as const;

export interface LibraryView {
  readonly text: string;
  readonly keyboard?: Keyboard | undefined;
}

function countByTopic(filings: readonly LibraryFiling[]): Map<LibraryTopicId, number> {
  const counts = new Map<LibraryTopicId, number>();
  for (const filing of filings) counts.set(filing.topicId, (counts.get(filing.topicId) ?? 0) + 1);
  return counts;
}

function topicsOf(tree: LibraryTree, vertical: LibraryVertical): LibraryTopic[] {
  const projects = new Set(
    tree.projects.filter((project) => project.verticalId === vertical.id).map((item) => item.id),
  );
  return tree.topics.filter((topic) => projects.has(topic.projectId));
}

/** The root: the verticals with what is filed in them. */
export async function libraryView(database: LibraryStore): Promise<LibraryView> {
  const [tree, filings] = await Promise.all([database.library.tree(), database.library.filings()]);
  if (tree.verticals.length === 0) {
    return {
      text: [
        '📚 Библиотека пуста.',
        'Библиотекарь сам разложит найденные боли и возможности по папкам: вертикаль → проект → тема. Ему нужен ваш доступ — карточка в /decisions.',
        LIBRARY_USAGE,
      ].join('\n'),
    };
  }
  const counts = countByTopic(filings);
  const lines = [
    `📚 Библиотека: вертикалей ${String(tree.verticals.length)} · проектов ${String(tree.projects.length)} · тем ${String(tree.topics.length)} · разложено ${String(filings.length)}`,
    '',
  ];
  const keyboard: Keyboard = [];
  for (const vertical of tree.verticals) {
    const topics = topicsOf(tree, vertical);
    const filed = topics.reduce((sum, topic) => sum + (counts.get(topic.id) ?? 0), 0);
    lines.push(`📁 ${vertical.name} — тем ${String(topics.length)}, разложено ${String(filed)}`);
    if (keyboard.length < MAX_BUTTONS) {
      keyboard.push([
        callbackButton(`📁 ${shorten(vertical.name, 40)}`, `${LIBRARY_PREFIX}:v:${vertical.id}`),
      ]);
    }
  }
  lines.push(
    '',
    'Раскладывает библиотекарь. Легло не туда — откройте тему и нажмите «Переложить».',
    LIBRARY_USAGE,
  );
  return { text: lines.join('\n'), keyboard };
}

/** One vertical: its projects and topics. */
export async function libraryVerticalView(
  database: LibraryStore,
  verticalId: string,
): Promise<LibraryView | undefined> {
  const [tree, filings] = await Promise.all([database.library.tree(), database.library.filings()]);
  const vertical = tree.verticals.find((item) => item.id === verticalId);
  if (vertical === undefined) return undefined;
  const counts = countByTopic(filings);
  const lines = [`📁 ${vertical.name}`];
  const keyboard: Keyboard = [];
  for (const project of tree.projects.filter((item) => item.verticalId === vertical.id)) {
    lines.push('', `▸ ${project.name}`);
    const topics = tree.topics.filter((topic) => topic.projectId === project.id);
    if (topics.length === 0) lines.push('   тем пока нет');
    for (const topic of topics) {
      lines.push(`   • ${topic.name} — ${String(counts.get(topic.id) ?? 0)}`);
      if (keyboard.length < MAX_BUTTONS) {
        keyboard.push([
          callbackButton(`📄 ${shorten(topic.name, 40)}`, `${LIBRARY_PREFIX}:t:${topic.id}`),
        ]);
      }
    }
  }
  if (lines.length === 1) lines.push('', 'Проектов пока нет.');
  keyboard.push([callbackButton('⬅️ К вертикалям', `${LIBRARY_PREFIX}:r`)]);
  return { text: lines.join('\n'), keyboard };
}

async function titlesOf(
  database: LibraryStore,
  filings: readonly LibraryFiling[],
): Promise<Map<string, string>> {
  const ids = (type: LibraryObjectType) =>
    filings.filter((filing) => filing.objectType === type).map((filing) => filing.objectId);
  const [pains, opportunities] = await Promise.all([
    database.repositories.pains.getByIds(ids('pain') as PainId[]),
    database.repositories.opportunities.getByIds(ids('opportunity') as OpportunityId[]),
  ]);
  return new Map([...pains, ...opportunities].map((item) => [item.id as string, item.title]));
}

/** One topic: what is filed there, with a «Переложить» button for each of the first objects. */
export async function libraryTopicView(
  database: LibraryStore,
  topicId: string,
): Promise<LibraryView | undefined> {
  const parsed = libraryTopicIdSchema.safeParse(topicId);
  if (!parsed.success) return undefined;
  const tree = await database.library.tree();
  const path = libraryPath(tree, parsed.data);
  const topic = tree.topics.find((item) => item.id === parsed.data);
  const project = tree.projects.find((item) => item.id === topic?.projectId);
  if (path === undefined || project === undefined) return undefined;
  const filings = await database.library.filings({ topicId: parsed.data });
  const titles = await titlesOf(database, filings.slice(0, SHOWN_OBJECTS));
  const lines = [`📄 ${path}`, `Разложено: ${String(filings.length)}`];
  const keyboard: Keyboard = [];
  filings.slice(0, SHOWN_OBJECTS).forEach((filing, index) => {
    const title = titles.get(filing.objectId);
    lines.push(
      '',
      `${String(index + 1)}. ${OBJECT_LABELS[filing.objectType]}: «${shorten(title ?? 'без названия', 140)}»` +
        (filing.byOwner ? ' — положили вы' : ''),
    );
    keyboard.push([
      callbackButton(
        `↪️ Переложить ${String(index + 1)}`,
        `${LIBRARY_PREFIX}:m:${OBJECT_CODES[filing.objectType]}:${filing.objectId}`,
      ),
    ]);
  });
  if (filings.length === 0) lines.push('', 'Пока пусто.');
  if (filings.length > SHOWN_OBJECTS) {
    lines.push('', `…и ещё ${String(filings.length - SHOWN_OBJECTS)}.`);
  }
  keyboard.push([callbackButton('⬅️ Назад', `${LIBRARY_PREFIX}:v:${project.verticalId}`)]);
  return { text: lines.join('\n'), keyboard };
}

/** One digest line when something was filed during the day. */
export async function libraryDigestLine(
  database: Pick<Database, 'library'>,
  nowMs: number,
): Promise<string | undefined> {
  const filed = await database.library.filedSince(toTimestamp(new Date(nowMs - DAY_MS)));
  return filed === 0 ? undefined : `📚 Новое в библиотеке за сутки: ${String(filed)} → /library`;
}

/** «Вертикаль / Проект / Тема» of `/library add`, or undefined when it is not three names. */
export function libraryPlaceOf(text: string): LibraryPlace | undefined {
  const parts = text.split('/').map((part) => part.trim());
  const [vertical, project, topic] = parts;
  return parts.length !== 3 ||
    vertical === undefined ||
    project === undefined ||
    topic === undefined
    ? undefined
    : { vertical, project, topic };
}

export interface LibraryFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (userId: number) => Actor;
}

export interface LibraryFlow {
  readonly library: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

type Pending =
  | {
      readonly kind: 'move';
      readonly objectType: LibraryObjectType;
      readonly objectId: string;
      readonly title: string;
      /** The lists the buttons of each step index into. */
      verticalIds: readonly string[];
      topicIds: readonly LibraryTopicId[];
      topicId?: LibraryTopicId | undefined;
      expiresAtMs: number;
    }
  | { readonly kind: 'add'; readonly place: LibraryPlace; expiresAtMs: number };

const STALE = '⌛ Подтверждение устарело. Повторите /library.';

export function createLibraryFlow(deps: LibraryFlowDeps): LibraryFlow {
  const { database } = deps;
  const pending = new Map<string, Pending>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(item: Pending): string {
    const current = nowMs();
    for (const [nonce, entry] of pending) if (entry.expiresAtMs <= current) pending.delete(nonce);
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const nonce = randomBytes(8).toString('hex');
    pending.set(nonce, item);
    return nonce;
  }

  const live = (nonce: string | undefined): Pending | undefined => {
    const item = nonce === undefined ? undefined : pending.get(nonce);
    return item === undefined || item.expiresAtMs <= nowMs() ? undefined : item;
  };

  async function show(context: CallbackContext, view: LibraryView | undefined): Promise<void> {
    if (view === undefined) await context.edit('Папка не найдена. Повторите /library.');
    else await context.edit(view.text, view.keyboard);
  }

  return {
    async library(context) {
      const args = context.args.trim();
      if (args === '') {
        const view = await libraryView(database);
        await context.reply(view.text, view.keyboard);
        return;
      }
      const place = /^add\s/i.test(args) ? libraryPlaceOf(args.replace(/^add\s+/i, '')) : undefined;
      if (place === undefined) {
        await context.reply(`⛔ ${LIBRARY_USAGE}`);
        return;
      }
      const tree = await database.library.tree();
      const nodes = newLibraryNodes(
        tree,
        place,
        { actor: deps.owner(context.userId), at: deps.now() },
        uuidv7,
      );
      if ('rejected' in nodes) {
        await context.reply(`⛔ ${REJECTIONS[nodes.rejected]}\n${LIBRARY_USAGE}`);
        return;
      }
      if (nodes.created === undefined) {
        await context.reply(`Такая тема уже есть: ${libraryPath(tree, nodes.topic.id) ?? ''}`);
        return;
      }
      const nonce = remember({
        kind: 'add',
        place,
        expiresAtMs: nowMs() + CONFIRMATION_TTL_MS,
      });
      const created = [
        ...(nodes.vertical === undefined ? [] : [`вертикаль «${nodes.vertical.name}»`]),
        ...(nodes.project === undefined ? [] : [`проект «${nodes.project.name}»`]),
        `тема «${nodes.created.name}»`,
      ];
      await context.reply(`📚 Создать: ${created.join(', ')}? Подтверждение действует 10 минут.`, [
        [
          callbackButton('📚 Создать', `${LIBRARY_PREFIX}:y:${nonce}`),
          callbackButton('Отмена', `${LIBRARY_PREFIX}:n:${nonce}`),
        ],
      ]);
    },

    async handleButton(context) {
      // The router passes the data after `lib:`.
      const [action, first, second] = context.data.split(':');

      if (action === 'r') {
        await show(context, await libraryView(database));
        return;
      }
      if (action === 'v' && first !== undefined) {
        await show(context, await libraryVerticalView(database, first));
        return;
      }
      if (action === 't' && first !== undefined) {
        await show(context, await libraryTopicView(database, first));
        return;
      }

      // Move, step 1: the object → the vertical it goes to.
      if (action === 'm' && second !== undefined) {
        const objectType = objectTypeOf(first);
        const from =
          objectType === undefined ? undefined : await database.library.topicOf(objectType, second);
        if (objectType === undefined || from === undefined) {
          await context.edit('Карточка устарела. Повторите /library.');
          return;
        }
        const tree = await database.library.tree();
        const [filing] = (await database.library.filings({ topicId: from })).filter(
          (item) => item.objectId === second && item.objectType === objectType,
        );
        const title =
          filing === undefined ? undefined : (await titlesOf(database, [filing])).get(second);
        const verticalIds = tree.verticals.slice(0, MAX_BUTTONS).map((item) => item.id as string);
        const nonce = remember({
          kind: 'move',
          objectType,
          objectId: second,
          title: title ?? 'без названия',
          verticalIds,
          topicIds: [],
          expiresAtMs: nowMs() + CONFIRMATION_TTL_MS,
        });
        await context.edit(
          `↪️ Куда переложить «${shorten(title ?? 'без названия', 140)}»?\nСейчас: ${libraryPath(tree, from) ?? '—'}\nВыберите вертикаль.`,
          [
            ...tree.verticals
              .slice(0, MAX_BUTTONS)
              .map((vertical, index) => [
                callbackButton(
                  `📁 ${shorten(vertical.name, 40)}`,
                  `${LIBRARY_PREFIX}:mv:${nonce}:${String(index)}`,
                ),
              ]),
            [callbackButton('Отмена', `${LIBRARY_PREFIX}:n:${nonce}`)],
          ],
        );
        return;
      }

      // Move, step 2: the vertical → one of its topics.
      if (action === 'mv') {
        const item = live(first);
        const verticalId = item?.kind === 'move' ? item.verticalIds[Number(second)] : undefined;
        if (item?.kind !== 'move' || first === undefined || verticalId === undefined) {
          await context.edit(STALE);
          return;
        }
        const tree = await database.library.tree();
        const vertical = tree.verticals.find((entry) => entry.id === verticalId);
        const topics = vertical === undefined ? [] : topicsOf(tree, vertical).slice(0, MAX_BUTTONS);
        if (vertical === undefined || topics.length === 0) {
          await context.edit(
            'В этой вертикали нет тем. Создайте: /library add Вертикаль / Проект / Тема — и повторите.',
          );
          return;
        }
        item.topicIds = topics.map((topic) => topic.id);
        await context.edit(`↪️ «${shorten(item.title, 140)}» → ${vertical.name}. Выберите тему.`, [
          ...topics.map((topic, index) => {
            const project = tree.projects.find((entry) => entry.id === topic.projectId);
            return [
              callbackButton(
                shorten(`${project?.name ?? ''} › ${topic.name}`, 60),
                `${LIBRARY_PREFIX}:mt:${first}:${String(index)}`,
              ),
            ];
          }),
          [callbackButton('Отмена', `${LIBRARY_PREFIX}:n:${first}`)],
        ]);
        return;
      }

      // Move, step 3: the topic → the question.
      if (action === 'mt') {
        const item = live(first);
        const topicId = item?.kind === 'move' ? item.topicIds[Number(second)] : undefined;
        if (item?.kind !== 'move' || first === undefined || topicId === undefined) {
          await context.edit(STALE);
          return;
        }
        const path = libraryPath(await database.library.tree(), topicId);
        if (path === undefined) {
          await context.edit(STALE);
          return;
        }
        item.topicId = topicId;
        await context.edit(
          `↪️ Переложить «${shorten(item.title, 140)}» в «${path}»? Библиотекарь учтёт это как пример. Подтверждение действует 10 минут.`,
          [
            [
              callbackButton('↪️ Да, переложить', `${LIBRARY_PREFIX}:y:${first}`),
              callbackButton('Отмена', `${LIBRARY_PREFIX}:n:${first}`),
            ],
          ],
        );
        return;
      }

      if (action === 'n' && first !== undefined) {
        pending.delete(first);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      const confirmation = live(first);
      if (action !== 'y' || first === undefined || confirmation === undefined) {
        await context.edit(STALE);
        return;
      }
      const actor = deps.owner(context.userId);
      const correlationId = `tg-update-${String(context.updateId)}`;
      const command = {
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId,
      };

      if (confirmation.kind === 'add') {
        const { result } = await database.command(
          { ...command, name: 'library.add' },
          async (scope) => {
            const tree = await scope.library.tree();
            const nodes = newLibraryNodes(
              tree,
              confirmation.place,
              { actor, at: deps.now() },
              uuidv7,
            );
            if ('rejected' in nodes) return { path: '' };
            await storeLibraryNodes(scope.repositories, nodes);
            return { path: libraryPath(withLibraryNodes(tree, nodes), nodes.topic.id) ?? '' };
          },
        );
        pending.delete(first);
        await context.edit(
          result.path === ''
            ? 'Не создано: дерево изменилось. Повторите /library add.'
            : `📚 Создано: ${result.path}. Смотреть — /library.`,
        );
        return;
      }

      const { topicId } = confirmation;
      if (topicId === undefined) {
        await context.edit(STALE);
        return;
      }
      const { result } = await database.command(
        { ...command, name: 'library.move' },
        async (scope) => {
          const path = libraryPath(await scope.library.tree(), topicId);
          if (path === undefined) return { path: '' };
          await scope.library.file({
            objectType: confirmation.objectType,
            objectId: confirmation.objectId,
            topicId,
            actorType: 'owner',
            actorId: actor.id,
            correlationId,
          });
          return { path };
        },
      );
      pending.delete(first);
      await context.edit(
        result.path === ''
          ? 'Не переложено: тема больше не активна. Повторите /library.'
          : `↪️ Переложено в «${result.path}».`,
      );
    },
  };
}
