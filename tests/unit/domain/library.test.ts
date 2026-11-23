import { describe, expect, it } from 'vitest';
import {
  createLibraryProject,
  createLibraryTopic,
  createLibraryVertical,
  DomainError,
  LIBRARY_LIMITS,
  libraryNameKey,
  libraryNameSchema,
  libraryPath,
  libraryProjectIdSchema,
  libraryTopicIdSchema,
  libraryVerticalIdSchema,
  newLibraryNodes,
  planLibraryPlace,
  setLibraryTopicStatus,
  withLibraryNodes,
  type LibraryTree,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at, INTEGRATION, MEMBER, OWNER, SYSTEM } from '../../support/domain.js';

const ctx = { actor: AGENT, at: at() };
const vertical = (name: string) =>
  createLibraryVertical(name, { ...ctx, id: libraryVerticalIdSchema.parse(uuidv7()) });
const project = (verticalId: string, name: string) =>
  createLibraryProject(
    { verticalId: libraryVerticalIdSchema.parse(verticalId), name },
    { ...ctx, id: libraryProjectIdSchema.parse(uuidv7()) },
  );
const topic = (projectId: string, name: string) =>
  createLibraryTopic(
    { projectId: libraryProjectIdSchema.parse(projectId), name },
    { ...ctx, id: libraryTopicIdSchema.parse(uuidv7()) },
  );

/** «Недвижимость › Тетиев › Дом на Шевченко». */
function realEstate(): LibraryTree {
  const homes = vertical('Недвижимость');
  const tetiiv = project(homes.id, 'Тетиев');
  return { verticals: [homes], projects: [tetiiv], topics: [topic(tetiiv.id, 'Дом на Шевченко')] };
}

describe('library names (phase 35)', () => {
  it('compares names without case and with «ё» as «е»', () => {
    expect(libraryNameKey('  Недвижимость ')).toBe(libraryNameKey('НЕДВИЖИМОСТЬ'));
    expect(libraryNameKey('Учёт')).toBe(libraryNameKey('учет'));
  });

  it('takes one line of 2–60 characters without a slash', () => {
    expect(libraryNameSchema.parse('  Дом\nна   Шевченко ')).toBe('Дом на Шевченко');
    for (const bad of ['Я', 'a'.repeat(61), 'Дом / участок', '-Дом', '']) {
      expect(libraryNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('who files and who archives (phase 35)', () => {
  it('lets the owner, an agent and code of the system create folders, nobody else', () => {
    for (const actor of [OWNER, AGENT, SYSTEM]) {
      expect(
        createLibraryVertical('Финансы', {
          actor,
          at: at(),
          id: libraryVerticalIdSchema.parse(uuidv7()),
        }).name,
      ).toBe('Финансы');
    }
    for (const actor of [MEMBER, INTEGRATION]) {
      expect(() =>
        createLibraryVertical('Финансы', {
          actor,
          at: at(),
          id: libraryVerticalIdSchema.parse(uuidv7()),
        }),
      ).toThrow(DomainError);
    }
  });

  it('lets only the owner archive a topic and bring it back', () => {
    const [item] = realEstate().topics;
    if (item === undefined) throw new Error('no topic');
    expect(() => setLibraryTopicStatus(item, 'archived', { actor: AGENT, at: at(1) })).toThrow(
      DomainError,
    );
    const archived = setLibraryTopicStatus(item, 'archived', { actor: OWNER, at: at(1) });
    expect(archived).toMatchObject({ status: 'archived', version: 2 });
    expect(setLibraryTopicStatus(archived, 'active', { actor: OWNER, at: at(2) }).status).toBe(
      'active',
    );
  });
});

describe('a place in the tree (phase 35)', () => {
  it('reuses the nodes with the same name and adds only what is missing', () => {
    const tree = realEstate();
    const same = newLibraryNodes(
      tree,
      { vertical: 'недвижимость', project: 'ТЕТИЕВ', topic: 'дом на шевченко' },
      ctx,
      uuidv7,
    );
    expect(same).toEqual({ topic: tree.topics[0] });

    const next = newLibraryNodes(
      tree,
      { vertical: 'Недвижимость', project: 'Тетиев', topic: 'Участок у реки' },
      ctx,
      uuidv7,
    );
    if ('rejected' in next) throw new Error(next.rejected);
    expect(next.vertical).toBeUndefined();
    expect(next.project).toBeUndefined();
    expect(next.created).toMatchObject({ name: 'Участок у реки', projectId: tree.projects[0]?.id });
    const grown = withLibraryNodes(tree, next);
    expect(libraryPath(grown, next.topic.id)).toBe('Недвижимость › Тетиев › Участок у реки');
  });

  it('creates a whole new branch when the vertical is new', () => {
    const nodes = newLibraryNodes(
      realEstate(),
      { vertical: 'Общепит', project: 'Рестораны', topic: 'Списание еды' },
      ctx,
      uuidv7,
    );
    if ('rejected' in nodes) throw new Error(nodes.rejected);
    expect(nodes.vertical?.name).toBe('Общепит');
    expect(nodes.project).toMatchObject({ name: 'Рестораны', verticalId: nodes.vertical?.id });
    expect(nodes.topic).toMatchObject({ name: 'Списание еды', projectId: nodes.project?.id });
    expect(nodes.topic.createdBy).toEqual(AGENT);
  });

  it('refuses bad names and keeps the limits of the tree', () => {
    const tree = realEstate();
    expect(
      planLibraryPlace(tree, { vertical: 'Недвижимость', project: 'Тетиев', topic: 'Я' }),
    ).toEqual({
      ok: false,
      reason: 'invalid_name',
    });

    const full: LibraryTree = {
      ...tree,
      verticals: [
        ...tree.verticals,
        ...Array.from({ length: LIBRARY_LIMITS.verticals - 1 }, (_, index) =>
          vertical(`Вертикаль ${String(index)}`),
        ),
      ],
    };
    expect(planLibraryPlace(full, { vertical: 'Общепит', project: 'Кафе', topic: 'Меню' })).toEqual(
      {
        ok: false,
        reason: 'too_many_verticals',
      },
    );
    // An existing vertical still takes new projects.
    expect(
      planLibraryPlace(full, { vertical: 'Недвижимость', project: 'Киев', topic: 'Офис' }).ok,
    ).toBe(true);

    const homes = tree.verticals[0];
    const tetiiv = tree.projects[0];
    if (homes === undefined || tetiiv === undefined) throw new Error('no tree');
    const manyProjects: LibraryTree = {
      ...tree,
      projects: Array.from({ length: LIBRARY_LIMITS.projectsPerVertical }, (_, index) =>
        project(homes.id, `Город ${String(index)}`),
      ),
    };
    expect(
      planLibraryPlace(manyProjects, {
        vertical: 'Недвижимость',
        project: 'Белая Церковь',
        topic: 'Дом',
      }),
    ).toEqual({ ok: false, reason: 'too_many_projects' });

    const manyTopics: LibraryTree = {
      ...tree,
      topics: Array.from({ length: LIBRARY_LIMITS.topicsPerProject }, (_, index) =>
        topic(tetiiv.id, `Объект ${String(index)}`),
      ),
    };
    expect(
      planLibraryPlace(manyTopics, {
        vertical: 'Недвижимость',
        project: 'Тетиев',
        topic: 'Ещё один',
      }),
    ).toEqual({ ok: false, reason: 'too_many_topics' });
    // A topic that exists is found even in a full project.
    expect(
      planLibraryPlace(manyTopics, {
        vertical: 'Недвижимость',
        project: 'Тетиев',
        topic: 'объект 7',
      }).ok,
    ).toBe(true);
  });

  it('gives no path for a topic outside the tree', () => {
    expect(libraryPath(realEstate(), libraryTopicIdSchema.parse(uuidv7()))).toBeUndefined();
  });
});
