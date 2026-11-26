import { describe, expect, it } from 'vitest';
import {
  fileLibraryTask,
  libraryInput,
  MAX_LIBRARY_MOVES,
  MAX_LIBRARY_TOPICS,
  toLibraryChoice,
  type FileLibraryExpected,
  type FileLibraryOutput,
} from '@roi-dealer/agents';
import {
  createLibraryProject,
  createLibraryTopic,
  createLibraryVertical,
  libraryProjectIdSchema,
  libraryTopicIdSchema,
  libraryVerticalIdSchema,
  type LibraryTopicId,
  type LibraryTree,
} from '@roi-dealer/domain';
import { painTerms } from '@roi-dealer/signals';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at } from '../../support/domain.js';

const KEYS = ['T1', 'T2', 'T3'];
const answer = (place: string, vertical = '', project = '', topic = ''): FileLibraryOutput => ({
  place,
  vertical,
  project,
  topic,
});

/** The answer a perfect model gives to a golden case. */
function perfect(expected: FileLibraryExpected): FileLibraryOutput {
  if (!('existing' in expected)) return answer(expected.place);
  return answer(
    'new',
    expected.vertical ?? 'Новая сфера',
    expected.project ?? 'Новый проект',
    'Новая тема',
  );
}

describe('the answer of file-library as code reads it (phase 35)', () => {
  it('takes a known topic key in any case', () => {
    expect(toLibraryChoice(answer(' t2 '), KEYS)).toEqual({ kind: 'existing', key: 'T2' });
    expect(toLibraryChoice(answer('T9'), KEYS)).toBeUndefined();
  });

  it('takes a new place only with three valid names', () => {
    expect(toLibraryChoice(answer('NEW', 'Общепит', 'Рестораны', 'Списание еды'), KEYS)).toEqual({
      kind: 'new',
      place: { vertical: 'Общепит', project: 'Рестораны', topic: 'Списание еды' },
    });
    expect(toLibraryChoice(answer('new', 'Общепит', 'Рестораны', ''), KEYS)).toBeUndefined();
    expect(toLibraryChoice(answer('new', 'Общепит', 'Кафе / бары', 'Меню'), KEYS)).toBeUndefined();
    expect(toLibraryChoice(answer('somewhere'), KEYS)).toBeUndefined();
  });
});

describe('the golden set of file-library (phase 35, D-021)', () => {
  it('has at least 20 cases, a perfect model passes and a lazy one fails', () => {
    const cases = fileLibraryTask.evalCases;
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(fileLibraryTask.tier).toBe('bulk');
    expect(fileLibraryTask.privateInput).toBeFalsy();
    expect(
      fileLibraryTask.score(cases.map(({ expected }) => ({ expected, output: perfect(expected) })))
        .passed,
    ).toBe(true);
    // Always «a new vertical» is wrong for every same-topic and same-vertical case.
    expect(
      fileLibraryTask.score(
        cases.map(({ expected }) => ({
          expected,
          output: answer('new', 'Разное', 'Разное', 'Разное'),
        })),
      ).passed,
    ).toBe(false);
  });
});

describe('what the model sees for one pain (phase 35)', () => {
  const id = () => uuidv7();
  const ctx = { actor: AGENT, at: at() };
  const finance = createLibraryVertical('Финансы', {
    ...ctx,
    id: libraryVerticalIdSchema.parse(id()),
  });
  const freelancers = createLibraryProject(
    { verticalId: finance.id, name: 'Фрилансеры' },
    { ...ctx, id: libraryProjectIdSchema.parse(id()) },
  );
  const topics = Array.from({ length: MAX_LIBRARY_TOPICS + 3 }, (_, index) =>
    createLibraryTopic(
      { projectId: freelancers.id, name: `Тема ${String(index)}` },
      { ...ctx, id: libraryTopicIdSchema.parse(id()) },
    ),
  );
  const tree: LibraryTree = { verticals: [finance], projects: [freelancers], topics };
  const filedAs = (topicId: LibraryTopicId, title: string, byOwner = false) => ({
    topicId,
    title,
    terms: painTerms(`${title} Freelancers`),
    byOwner,
  });

  it('shows the closest topics first, at most ten, under short keys', () => {
    const [late, taxes, ...others] = topics;
    if (late === undefined || taxes === undefined) throw new Error('no topics');
    const filed = [
      filedAs(taxes.id, 'Freelancers do not know how much tax to set aside'),
      filedAs(late.id, 'Freelancers chase clients for late invoice payments'),
      ...others.map((item, index) => filedAs(item.id, `Unrelated problem number ${String(index)}`)),
    ];
    const { input, topicOf } = libraryInput(
      { title: 'Freelancers wait months for invoice payments', audience: 'Freelancers' },
      tree,
      filed,
    );
    expect(input.topics).toHaveLength(MAX_LIBRARY_TOPICS);
    expect(input.topics[0]).toMatchObject({ key: 'T1', path: 'Финансы › Фрилансеры › Тема 0' });
    expect(topicOf.get('T1')).toBe(late.id);
    expect(input.tree).toEqual([{ vertical: 'Финансы', projects: ['Фрилансеры'] }]);
    expect(input.moves).toEqual([]);
  });

  it('passes the owner’s moves as examples, newest first, and no more than six', () => {
    const [first] = topics;
    if (first === undefined) throw new Error('no topics');
    const moves = Array.from({ length: MAX_LIBRARY_MOVES + 2 }, (_, index) =>
      filedAs(first.id, `Moved by the owner ${String(index)}`, true),
    );
    const { input } = libraryInput({ title: 'Anything', audience: 'Anyone' }, tree, moves);
    expect(input.moves).toHaveLength(MAX_LIBRARY_MOVES);
    expect(input.moves[0]).toEqual({
      title: 'Moved by the owner 0',
      path: 'Финансы › Фрилансеры › Тема 0',
    });
  });
});
