import { z } from 'zod';
import type { AiTask, EvalScore } from '@roi-dealer/ai-runtime';
import { libraryNameKey, libraryNameSchema, type LibraryPlace } from '@roi-dealer/domain';

/*
 * Phase 35 (ADR-0016): where does a new pain go in the library — vertical → project → topic?
 * The model names an existing topic by its key, or proposes a new place; code checks the names,
 * reuses nodes with the same name and keeps the limits of the tree (§2.3).
 */

export const NEW_PLACE = 'new';
export const MAX_LIBRARY_TOPICS = 10;
export const MAX_LIBRARY_VERTICALS = 20;
export const MAX_LIBRARY_PROJECTS_SHOWN = 8;
export const MAX_LIBRARY_MOVES = 6;

const title = z.string().min(1).max(300);
const audience = z.string().min(1).max(200);
const path = z.string().min(1).max(200);
const name = z.string().min(1).max(60);

const input = z.strictObject({
  item: z.strictObject({ title, audience }),
  /** The closest existing topics, each with one thing already filed there. */
  topics: z
    .array(
      z.strictObject({ key: z.string().regex(/^T\d{1,2}$/), path, example: z.string().max(300) }),
    )
    .max(MAX_LIBRARY_TOPICS),
  /** The verticals with their first projects, so that names are reused. */
  tree: z
    .array(
      z.strictObject({ vertical: name, projects: z.array(name).max(MAX_LIBRARY_PROJECTS_SHOWN) }),
    )
    .max(MAX_LIBRARY_VERTICALS),
  /** What the owner moved by hand: how the owner sorts. */
  moves: z.array(z.strictObject({ title, path })).max(MAX_LIBRARY_MOVES),
});
const output = z.strictObject({
  place: z.string(),
  vertical: z.string(),
  project: z.string(),
  topic: z.string(),
});

export type FileLibraryInput = z.infer<typeof input>;
export type FileLibraryOutput = z.infer<typeof output>;

/** What a correct answer is: a topic key, or a new place in a known or a new vertical. */
export type FileLibraryExpected =
  | { readonly place: string }
  | {
      readonly place: typeof NEW_PLACE;
      /** The existing vertical it belongs to; absent when a new vertical is right. */
      readonly vertical?: string;
      /** The existing project it belongs to, when there is one. */
      readonly project?: string;
      /** The verticals that exist: a new vertical must not repeat one of them. */
      readonly existing: readonly string[];
    };

export type LibraryChoice =
  | { readonly kind: 'existing'; readonly key: string }
  | { readonly kind: 'new'; readonly place: LibraryPlace };

/** The answer as code reads it: a known topic key, or three valid names; otherwise nothing. */
export function toLibraryChoice(
  answer: FileLibraryOutput,
  keys: readonly string[],
): LibraryChoice | undefined {
  const place = answer.place.trim();
  if (keys.includes(place.toUpperCase())) return { kind: 'existing', key: place.toUpperCase() };
  if (place.toLowerCase() !== NEW_PLACE) return undefined;
  const names = z
    .object({ vertical: libraryNameSchema, project: libraryNameSchema, topic: libraryNameSchema })
    .safeParse(answer);
  return names.success ? { kind: 'new', place: names.data } : undefined;
}

const BASE_TREE = [
  { vertical: 'Финансы и платежи', projects: ['Фрилансеры', 'Малый бизнес'] },
  { vertical: 'Здоровье', projects: ['Клиники'] },
  { vertical: 'Разработка ПО', projects: ['Малые команды'] },
  { vertical: 'Электронная коммерция', projects: ['Интернет-магазины'] },
  { vertical: 'Недвижимость', projects: ['Арендодатели'] },
];
const BASE_TOPICS = [
  [
    'Финансы и платежи › Фрилансеры › Просроченные оплаты клиентов',
    'Freelancers waste time chasing late client payments',
  ],
  [
    'Финансы и платежи › Малый бизнес › Сверка выплат с бухгалтерией',
    'Small agencies spend hours reconciling payouts with accounting software',
  ],
  [
    'Здоровье › Клиники › Неявки пациентов',
    'Clinics lose revenue because patients miss appointments',
  ],
  [
    'Разработка ПО › Малые команды › Шумные ночные оповещения',
    'Small teams burn out from noisy on-call alerts',
  ],
  [
    'Электронная коммерция › Интернет-магазины › Рассинхрон остатков',
    'Online stores oversell when inventory is not synchronized',
  ],
  [
    'Недвижимость › Арендодатели › Заявки на ремонт от жильцов',
    'Landlords lose track of tenant repair requests',
  ],
].map(([topicPath, example], index) => ({
  key: `T${String(index + 1)}`,
  path: topicPath ?? '',
  example: example ?? '',
}));
const EXISTING = BASE_TREE.map((item) => item.vertical);

type Golden = readonly [title: string, audience: string, expected: FileLibraryExpected];
const inPlace = (vertical: string, project?: string): FileLibraryExpected => ({
  place: NEW_PLACE,
  vertical,
  ...(project === undefined ? {} : { project }),
  existing: EXISTING,
});
const golden: readonly Golden[] = [
  // The same problem as an existing topic, in other words.
  [
    'Freelance designers struggle to get clients to pay invoices on time',
    'Freelance designers',
    { place: 'T1' },
  ],
  [
    'Accountants spend hours matching Stripe payouts to bookkeeping entries',
    'Accountants at small firms',
    { place: 'T2' },
  ],
  ['Patients often skip booked appointments at small clinics', 'Small clinics', { place: 'T3' }],
  ['Small teams get woken up at night by false alerts', 'Small engineering teams', { place: 'T4' }],
  [
    'Sellers oversell because stock does not sync between Shopify and Amazon',
    'Multichannel sellers',
    { place: 'T5' },
  ],
  [
    'Property managers struggle to track maintenance requests from tenants',
    'Property managers',
    { place: 'T6' },
  ],
  [
    'Dental practices suffer from no-shows despite SMS reminders',
    'Dental practices',
    { place: 'T3' },
  ],
  [
    'Contractors wait months for agencies to pay their invoices',
    'Independent contractors',
    { place: 'T1' },
  ],
  [
    'On-call engineers ignore pages because most alerts are noise',
    'On-call engineers',
    { place: 'T4' },
  ],
  [
    'Marketplace sellers cancel orders after stock counts drift between channels',
    'Marketplace sellers',
    { place: 'T5' },
  ],
  // A new problem of a known audience: a new topic in the same vertical and project.
  [
    'Freelancers do not know how much to set aside for quarterly taxes',
    'Freelancers',
    inPlace('Финансы и платежи', 'Фрилансеры'),
  ],
  [
    'Clinics spend hours on insurance pre-authorization paperwork',
    'Small clinics',
    inPlace('Здоровье', 'Клиники'),
  ],
  [
    'Small teams lose days to flaky end-to-end tests',
    'Small engineering teams',
    inPlace('Разработка ПО', 'Малые команды'),
  ],
  [
    'Online stores answer the same shipping questions every day',
    'Online stores',
    inPlace('Электронная коммерция', 'Интернет-магазины'),
  ],
  [
    'Landlords struggle to screen tenants without expensive background checks',
    'Small landlords',
    inPlace('Недвижимость', 'Арендодатели'),
  ],
  [
    'Small businesses cannot forecast cash flow from unpaid invoices and bills',
    'Small business owners',
    inPlace('Финансы и платежи', 'Малый бизнес'),
  ],
  // A known field, another audience: the vertical is reused, the project is new.
  [
    'Real estate agents lose leads because they reply to inquiries too slowly',
    'Real estate agents',
    inPlace('Недвижимость'),
  ],
  [
    'Hospitals struggle to schedule nurses across shifts fairly',
    'Hospital nurse managers',
    inPlace('Здоровье'),
  ],
  [
    'Enterprise developers wait hours for CI builds on large monorepos',
    'Enterprise developers',
    inPlace('Разработка ПО'),
  ],
  // Nothing fits: a new vertical.
  [
    'Restaurants throw away food because weekday demand is unpredictable',
    'Restaurant owners',
    { place: NEW_PLACE, existing: EXISTING },
  ],
  [
    'Teachers spend evenings grading essays by hand',
    'High school teachers',
    { place: NEW_PLACE, existing: EXISTING },
  ],
  [
    'Small farms cannot predict irrigation needs from weather data',
    'Small farm owners',
    { place: NEW_PLACE, existing: EXISTING },
  ],
];

const cases: { input: FileLibraryInput; expected: FileLibraryExpected }[] = golden.map(
  ([itemTitle, itemAudience, expected]) => ({
    input: {
      item: { title: itemTitle, audience: itemAudience },
      topics: BASE_TOPICS,
      tree: BASE_TREE,
      moves: [],
    },
    expected,
  }),
);
// The owner's move shows where restaurants go: the same vertical and project are used.
cases.push({
  input: {
    item: {
      title: 'Restaurants throw away food because weekday demand is unpredictable',
      audience: 'Restaurant owners',
    },
    topics: BASE_TOPICS,
    tree: [...BASE_TREE, { vertical: 'Общепит', projects: ['Рестораны'] }],
    moves: [
      {
        title: 'Cafes lose regulars because paper loyalty cards get lost',
        path: 'Общепит › Рестораны › Программы лояльности',
      },
    ],
  },
  expected: {
    place: NEW_PLACE,
    vertical: 'Общепит',
    project: 'Рестораны',
    existing: [...EXISTING, 'Общепит'],
  },
});

const ALL_KEYS = Array.from({ length: 99 }, (_, index) => `T${String(index + 1)}`);

function isCorrect(expected: FileLibraryExpected, answer: FileLibraryOutput): boolean {
  const choice = toLibraryChoice(answer, ALL_KEYS);
  if (choice === undefined) return false;
  if (!('existing' in expected)) return choice.kind === 'existing' && choice.key === expected.place;
  if (choice.kind !== 'new') return false;
  const vertical = libraryNameKey(choice.place.vertical);
  if (expected.vertical === undefined) {
    return !expected.existing.some((item) => libraryNameKey(item) === vertical);
  }
  return (
    vertical === libraryNameKey(expected.vertical) &&
    (expected.project === undefined ||
      libraryNameKey(choice.place.project) === libraryNameKey(expected.project))
  );
}

export function scoreFileLibrary(
  results: readonly {
    readonly expected: FileLibraryExpected;
    readonly output: FileLibraryOutput | undefined;
  }[],
): EvalScore {
  let correct = 0;
  let answered = 0;
  for (const { expected, output: answer } of results) {
    if (answer === undefined) continue;
    answered += 1;
    if (isCorrect(expected, answer)) correct += 1;
  }
  const accuracy = results.length === 0 ? 0 : correct / results.length;
  const answeredShare = results.length === 0 ? 0 : answered / results.length;
  return {
    passed: accuracy >= 0.8 && answeredShare >= 0.9,
    metrics: { accuracy, answered: answeredShare },
  };
}

export const fileLibraryTask: AiTask<FileLibraryInput, FileLibraryOutput, FileLibraryExpected> = {
  name: 'file-library',
  version: 1,
  tier: 'bulk',
  instructions: [
    'You file a new item into a library with three levels: vertical → project → topic.',
    'A vertical is a broad field (1–3 words). A project is the audience or the direction inside',
    'the field. A topic is one specific problem (2–6 words).',
    'If the item is the same problem as one of the existing topics, even in other words, answer',
    'with the key of that topic in "place" (for example T3) and leave the other fields empty.',
    'Otherwise answer "new" in "place" and give the vertical, the project and the topic.',
    'Reuse an existing vertical and an existing project with exactly the same name whenever they',
    'fit; make a new vertical only when no existing one fits.',
    'Names are in Russian, short, without slashes. The items themselves are in English.',
    "The owner's moves show how the owner sorts: follow them.",
  ].join('\n'),
  input,
  output,
  render: ({ item, topics, tree, moves }) =>
    [
      'New item:',
      `- title: ${item.title}`,
      `- audience: ${item.audience}`,
      '',
      'Closest existing topics:',
      ...(topics.length === 0
        ? ['(none)']
        : topics.map((topic) => `${topic.key}: ${topic.path} (filed there: ${topic.example})`)),
      '',
      'Verticals and their projects:',
      ...(tree.length === 0
        ? ['(the library is empty)']
        : tree.map(
            (node) =>
              `- ${node.vertical}: ${node.projects.length === 0 ? '(no projects)' : node.projects.join('; ')}`,
          )),
      ...(moves.length === 0
        ? []
        : ['', "The owner's moves:", ...moves.map((move) => `- ${move.title} → ${move.path}`)]),
    ].join('\n'),
  maxOutputTokens: 512,
  // Worst case: ten topics, twenty verticals with eight projects each and six moves at full
  // length (~21 000 characters, counted as tokens) and 512 output tokens on the dearest bulk
  // model.
  maxCostMicroUsd: 20_000,
  dailyShare: 0.02,
  evalCases: cases,
  score: scoreFileLibrary,
};
