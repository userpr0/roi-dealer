import { z } from 'zod';
import {
  catalogKeySchema,
  countryCodeSchema,
  httpUrlSchema,
  languageTagSchema,
  SOURCE_KINDS,
  TRUST_LEVELS,
  type Actor,
  type NewPrincipal,
  type NewSource,
} from '@roi-dealer/domain';
import { EvidenceEngineError } from './errors.js';

/*
 * Source catalog (PHASE 05, D-014 п.5): a source is connected only after its terms were checked
 * and recorded here. The catalog lives in code, so every change is a pull request the owner
 * merges. Owner-facing texts are in Russian, like the rest of the documentation.
 */

export const ACCESS_METHODS = ['official_api', 'rss', 'export', 'manual'] as const;
export const AUTHENTICATION_KINDS = ['none', 'api_key', 'oauth', 'agreement'] as const;
export const PERSONAL_DATA_RISKS = ['low', 'medium', 'high'] as const;

/**
 * `allowed` — may be connected; `needs_agreement` — the platform requires a contract;
 * `needs_review` — terms are not confirmed yet; `rejected` — not connected.
 */
export const CATALOG_VERDICTS = ['allowed', 'needs_agreement', 'needs_review', 'rejected'] as const;
export type CatalogVerdict = (typeof CATALOG_VERDICTS)[number];

const isoDateSchema = z.iso.date();
const noteSchema = z.string().trim().min(1).max(500);

export const catalogEntrySchema = z.strictObject({
  key: catalogKeySchema,
  /** Display name; also the name of the access request and the source. */
  name: z.string().trim().min(1).max(100),
  siteUrl: httpUrlSchema,
  sourceKind: z.enum(SOURCE_KINDS),
  access: z.strictObject({
    method: z.enum(ACCESS_METHODS),
    endpoint: httpUrlSchema,
    authentication: z.enum(AUTHENTICATION_KINDS),
    /** Search by words, for the research agent (PHASE 10); absent when the source has none. */
    searchEndpoint: httpUrlSchema.optional(),
  }),
  terms: z.strictObject({
    urls: z.array(httpUrlSchema).min(1),
    summary: noteSchema,
    /** Conditions we follow when the source is used. */
    conditions: z.array(noteSchema),
  }),
  cost: noteSchema,
  limits: z.strictObject({
    /** What the provider states. */
    provider: noteSchema,
    /** Our own politeness limits: at most one load per interval, at most N items per load. */
    minIntervalMinutes: z.int().min(5).max(1_440),
    maxItemsPerRun: z.int().min(1).max(100),
    /** At most N new items per search (PHASE 10); required with `access.searchEndpoint`. */
    maxItemsPerSearch: z.int().min(1).max(30).optional(),
  }),
  dataFields: z.strictObject({
    provided: z.array(noteSchema).min(1),
    stored: z.array(noteSchema),
  }),
  personalData: z.strictObject({ risk: z.enum(PERSONAL_DATA_RISKS), notes: noteSchema }),
  markets: z.array(countryCodeSchema).min(1),
  languages: z.array(languageTagSchema).min(1),
  /** Market of the evidence items, when the audience is one market; absent for global sources. */
  evidenceMarket: countryCodeSchema.optional(),
  defaultTrust: z.enum(TRUST_LEVELS),
  review: z.strictObject({
    verdict: z.enum(CATALOG_VERDICTS),
    checkedBy: noteSchema,
    checkedOn: isoDateSchema,
    notes: noteSchema,
  }),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Checked in October 2026 (D-019); see docs/phases/05_evidence_engine.md. */
export const SOURCE_CATALOG: readonly CatalogEntry[] = [
  {
    key: 'hacker-news',
    name: 'Hacker News',
    siteUrl: 'https://news.ycombinator.com',
    sourceKind: 'forum',
    access: {
      method: 'official_api',
      endpoint: 'https://hacker-news.firebaseio.com/v0',
      authentication: 'none',
      searchEndpoint: 'https://hn.algolia.com/api/v1',
    },
    terms: {
      urls: [
        'https://github.com/HackerNews/API',
        'https://www.ycombinator.com/legal/',
        'https://hn.algolia.com/api',
      ],
      summary:
        'Официальный публичный read-only API Y Combinator. Отдельных условий для данных API нет; берём минимум.',
      conditions: [
        'Только посты Ask HN: заголовок и текст, цитата до 1 000 символов',
        'Без ников, профилей и контактов авторов',
        'Ничего не публикуем: цитаты — только доказательства внутри системы (§2.20)',
        'Ссылка на оригинал сохраняется для проверки',
        'Поиск Ask HN по словам боли (агент исследований, PHASE 10) — HN Search API (Algolia), на который ведёт поиск сайта HN: до 10 постов на запрос, до 3 запросов за 6 часов',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Лимит не заявлен',
      minIntervalMinutes: 60,
      maxItemsPerRun: 30,
      maxItemsPerSearch: 10,
    },
    dataFields: {
      provided: ['id', 'type', 'by', 'time', 'title', 'text (HTML)', 'url', 'score', 'kids'],
      stored: ['id', 'time', 'title + text (очищенные)', 'ссылка на пост'],
    },
    personalData: {
      risk: 'medium',
      notes:
        'Поле by (ник) не сохраняется; контакты и ссылки на профили в тексте вычищаются. Остаточный риск — имена в тексте (PHASE 09).',
    },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes:
        'Документация API: бесплатно, без авторизации, лимит не заявлен. Аудитория глобальная англоязычная, ядро — США; рынок у Evidence не присваивается. Поиск (2026-10-19): отдельных условий у HN Search API не опубликовано; лимит 10 000 запросов в час с IP — по сторонним источникам.',
    },
  },
  {
    key: 'reddit',
    name: 'Reddit',
    siteUrl: 'https://www.reddit.com',
    sourceKind: 'forum',
    access: {
      method: 'official_api',
      endpoint: 'https://oauth.reddit.com',
      authentication: 'agreement',
    },
    terms: {
      urls: ['https://redditinc.com/policies/data-api-terms'],
      summary:
        'Data API Terms: коммерческое использование — только по отдельному договору с Reddit; с ноября 2025 доступ выдаётся по одобрению.',
      conditions: ['Не подключать без договора с Reddit; скрейпинг запрещён User Agreement'],
    },
    cost: 'По договору; публичного прайса нет',
    limits: {
      provider: '100 запросов в минуту на OAuth-клиент',
      minIntervalMinutes: 60,
      maxItemsPerRun: 30,
    },
    dataFields: { provided: ['посты', 'комментарии', 'сабреддиты'], stored: [] },
    personalData: { risk: 'high', notes: 'Ники, ссылки на профили, личные истории.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes:
        'Проверено по описаниям условий; официальный текст получить не удалось — сверить при обращении к Reddit.',
    },
  },
  {
    key: 'cfpb-complaints',
    name: 'CFPB Consumer Complaints',
    siteUrl: 'https://www.consumerfinance.gov/data-research/consumer-complaints/',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.consumerfinance.gov/complaint/data-use/'],
      summary:
        'Государственная база жалоб США. 14.08.2026 CFPB объявил, что прекращает публиковать тексты жалоб.',
      conditions: ['Не подключать: тексты, ради которых нужен источник, снимаются с публикации'],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 100 },
    dataFields: {
      provided: ['продукт', 'проблема', 'штат', 'текст жалобы (по согласию)'],
      stored: [],
    },
    personalData: { risk: 'low', notes: 'CFPB вычищает персональные данные из текстов.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes:
        'Структурные данные (продукт, проблема, штат) остаются — вернуться к ним для агрегатов, если понадобятся.',
    },
  },
  {
    key: 'stack-exchange',
    name: 'Stack Exchange',
    siteUrl: 'https://stackexchange.com',
    sourceKind: 'forum',
    access: {
      method: 'official_api',
      endpoint: 'https://api.stackexchange.com/2.3',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://stackoverflow.com/legal/api-terms-of-use'],
      summary:
        'Контент под CC BY-SA с атрибуцией; в 2024 введены ограничения на коммерческое и AI-использование выгрузок.',
      conditions: ['Подключать только после проверки текущих условий API'],
    },
    cost: 'Бесплатно с ключом (квота в сутки)',
    limits: { provider: 'Дневная квота на ключ', minIntervalMinutes: 60, maxItemsPerRun: 30 },
    dataFields: { provided: ['вопросы', 'ответы', 'теги'], stored: [] },
    personalData: { risk: 'medium', notes: 'Ники и ссылки на профили.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes: 'Официальный текст условий API не получен; аудитория — разработчики.',
    },
  },
  {
    key: 'bluesky',
    name: 'Bluesky',
    siteUrl: 'https://bsky.app',
    sourceKind: 'social',
    access: {
      method: 'official_api',
      endpoint: 'https://public.api.bsky.app/xrpc',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://docs.bsky.app', 'https://bsky.social/about/support/tos'],
      summary:
        'Открытый протокол AT; поиск постов требует авторизации (app password). Условия для коммерческого анализа не подтверждены.',
      conditions: ['Подключать только после проверки условий и правил для разработчиков'],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Лимиты по IP и аккаунту', minIntervalMinutes: 60, maxItemsPerRun: 30 },
    dataFields: { provided: ['посты', 'хендлы', 'DID'], stored: [] },
    personalData: { risk: 'high', notes: 'Хендлы и DID — идентификаторы людей.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes: 'Проверено по вторичным источникам.',
    },
  },
  {
    key: 'product-hunt',
    name: 'Product Hunt',
    siteUrl: 'https://www.producthunt.com',
    sourceKind: 'marketplace',
    access: {
      method: 'official_api',
      endpoint: 'https://api.producthunt.com/v2/api/graphql',
      authentication: 'oauth',
    },
    terms: {
      urls: ['https://api.producthunt.com/v2/docs'],
      summary: 'По правилам API коммерческое использование — с разрешения Product Hunt.',
      conditions: ['Подключать только с разрешением Product Hunt'],
    },
    cost: 'Бесплатно для некоммерческого использования',
    limits: { provider: 'Квота сложности запросов', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['продукты', 'описания', 'голоса', 'комментарии'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена и профили создателей.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes:
        'Условие о коммерческом использовании — по памяти; не подтверждено официальным текстом.',
    },
  },
  {
    key: 'github',
    name: 'GitHub Issues',
    siteUrl: 'https://github.com',
    sourceKind: 'forum',
    access: {
      method: 'official_api',
      endpoint: 'https://api.github.com',
      authentication: 'api_key',
    },
    terms: {
      urls: [
        'https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies',
        'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service',
      ],
      summary:
        'Acceptable Use Policies §7: информацию сервиса — через API или иначе — можно использовать только исследователям (публикации в открытом доступе) и архивистам.',
      conditions: [
        'Не подключать: коммерческий поиск болей не входит в разрешённые цели §7; §6 запрещает использовать сервис без письменного разрешения GitHub',
      ],
    },
    cost: 'Бесплатно (лимиты API)',
    limits: {
      provider: '5 000 запросов в час с токеном',
      minIntervalMinutes: 60,
      maxItemsPerRun: 30,
    },
    dataFields: { provided: ['issues', 'discussions', 'комментарии', 'логины'], stored: [] },
    personalData: { risk: 'medium', notes: 'Логины и ссылки на профили авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (13c, D-023)',
      checkedOn: '2026-10-20',
      notes:
        'Проверено по официальному тексту (репозиторий github/site-policy). Вернуться только с письменным разрешением GitHub.',
    },
  },
  {
    key: 'google-trends',
    name: 'Google Trends',
    siteUrl: 'https://trends.google.com',
    sourceKind: 'search_trends',
    access: {
      method: 'official_api',
      endpoint: 'https://developers.google.com/search/apis/trends',
      authentication: 'agreement',
    },
    terms: {
      urls: ['https://developers.google.com/search/apis/trends'],
      summary:
        'Официальный API доступен ограниченно (по заявке); неофициальные библиотеки — скрейпинг.',
      conditions: ['Не подключать до получения официального доступа'],
    },
    cost: 'Не опубликована',
    limits: { provider: 'По условиям доступа', minIntervalMinutes: 1_440, maxItemsPerRun: 10 },
    dataFields: { provided: ['индекс интереса к запросу по времени и регионам'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты без персональных данных.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (D-019)',
      checkedOn: '2026-10-18',
      notes: 'Вернуться, когда появится официальный доступ.',
    },
  },
];

export function findCatalogEntry(
  key: string,
  catalog: readonly CatalogEntry[] = SOURCE_CATALOG,
): CatalogEntry | undefined {
  return catalog.find((entry) => entry.key === key);
}

/**
 * The entry a connector may work with. Throws `not_cataloged` without an entry and
 * `not_allowed` unless its verdict is `allowed` (§2.21).
 */
export function connectableEntry(
  key: string,
  catalog: readonly CatalogEntry[] = SOURCE_CATALOG,
): CatalogEntry {
  const entry = findCatalogEntry(key, catalog);
  if (entry === undefined) {
    throw new EvidenceEngineError('not_cataloged', `Source ${key} is not in the catalog`, {
      catalog_key: key,
    });
  }
  if (entry.review.verdict !== 'allowed') {
    throw new EvidenceEngineError('not_allowed', `Source ${key} is not allowed`, {
      catalog_key: key,
      verdict: entry.review.verdict,
    });
  }
  return entry;
}

/** The identity a source writes as; the owner grants it in /decisions (PHASE 04). */
export function integrationActor(entry: Pick<CatalogEntry, 'key'>): Actor {
  return { type: 'integration', id: `source:${entry.key}` };
}

/** The access request shown to the owner: what is collected and on what terms. */
export function accessRequestFor(entry: CatalogEntry): NewPrincipal {
  const purpose = [
    `Сбор данных: ${entry.terms.summary}`,
    `Условия: ${entry.terms.conditions.join('; ')}.`,
    `${entry.cost}.`,
  ].join(' ');
  return {
    actor: integrationActor(entry),
    displayName: entry.name,
    purpose: purpose.length <= 500 ? purpose : `${purpose.slice(0, 499).trimEnd()}…`,
  };
}

/** The source record of a catalog entry. */
export function sourceFor(entry: CatalogEntry): NewSource {
  return {
    kind: entry.sourceKind,
    name: entry.name,
    url: entry.siteUrl,
    markets: [...entry.markets],
    languages: [...entry.languages],
    trust: entry.defaultTrust,
    catalogKey: entry.key,
  };
}
