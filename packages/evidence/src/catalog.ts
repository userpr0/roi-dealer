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

/**
 * Checked in October 2026 (D-019, D-026); see docs/phases/05_evidence_engine.md and the source
 * scout's reports in docs/sources/. Every checked source stays here, whatever its verdict, so
 * the scout does not check it twice.
 */
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
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Официальный текст условий API не получен: stackoverflow.com и stackexchange.com закрыты сетью среды (D-019, повторно 2026-10-20). Аудитория — разработчики.',
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
      urls: [
        'https://docs.bsky.app/docs/support/developer-guidelines',
        'https://bsky.social/about/support/tos',
      ],
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
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Проверено по вторичным источникам; docs.bsky.app и bsky.social закрыты сетью среды (повторно 2026-10-20). По выдаче поиска Developer Guidelines требуют удалять контент по запросу пользователя и запрещают массовые автоматические действия.',
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
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Условие о коммерческом использовании — по памяти; не подтверждено официальным текстом: producthunt.com закрыт сетью среды (повторно 2026-10-20).',
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
      conditions: [
        'Не подключать до одобрения заявки Google; неофициальные библиотеки и сервисы выгрузки не использовать',
      ],
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
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Официальный API — альфа по заявке, то есть доступ только с разрешения Google. Владелец подал заявку 2026-10-20. После одобрения: прочитать условия доступа, затем ключ — в Variables сервиса worker.',
    },
  },
  {
    key: 'npm-downloads',
    name: 'npm: загрузки пакетов',
    siteUrl: 'https://www.npmjs.com',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.npmjs.org/downloads',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://docs.npmjs.com/policies/open-source-terms',
        'https://github.com/npm/registry/blob/master/docs/download-counts.md',
      ],
      summary:
        'Публичный API числа загрузок пакетов npm по дням. Open Source Terms разрешают публично документированные API и использование в деловых целях.',
      conditions: [
        'Только публичный API, не сайт: автоматический доступ к сайту запрещён (Acceptable Use п. 9)',
        'Данные о безопасности пакетов не используем (Conditions п. 4)',
        'Сигнал спроса только для тем разработчиков; коннектор — после решения о хранении рядов (05b)',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider:
        'Пакетный запрос — до 128 пакетов и 365 дней; остальные — до 18 месяцев данных. Лимит частоты не заявлен',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['package', 'start', 'end', 'downloads (сумма или по дням)'],
      stored: ['пакет, период, число загрузок'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты по пакетам; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Прочитано в официальном репозитории npm/documentation (ред. 10.03.2022): «You may search for, download… via application programming interfaces that npm publicly documents» и «You are free to use npm Open Source for commercial projects… and for other business purposes». API загрузок описан npm в npm/registry. В загрузках есть CI и зеркала — только относительный сигнал.',
    },
  },
  {
    key: 'wikimedia-pageviews',
    name: 'Википедия: просмотры статей',
    siteUrl: 'https://wikimedia.org',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://wikimedia.org/api/rest_v1/metrics/pageviews',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html',
        'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use',
      ],
      summary:
        'Analytics API: просмотры статей Википедии по дням, без ключа — интерес к теме. Действуют Terms of Use Wikimedia.',
      conditions: [
        'Подключать только после чтения официальных условий',
        'User-Agent с названием, версией и контактом; запросы последовательно',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Не проверено: правила частоты — в access policy',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['статья', 'дата', 'число просмотров', 'тип доступа и агента'],
      stored: [],
    },
    personalData: { risk: 'low', notes: 'Агрегаты по статьям; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Официальный текст не прочитан: doc.wikimedia.org и foundation.wikimedia.org закрыты сетью среды. Выдача поиска цитирует официальную страницу: «Data provided by the API is available under the CC0 1.0 license». Кандидат на allowed после чтения.',
    },
  },
  {
    key: 'pypi-downloads',
    name: 'PyPI: загрузки пакетов',
    siteUrl: 'https://pypi.org',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://bigquery.googleapis.com/bigquery/v2',
      authentication: 'oauth',
    },
    terms: {
      urls: [
        'https://docs.pypi.org/api/bigquery/',
        'https://policies.python.org/pypi.org/Terms-of-Use/',
      ],
      summary:
        'Официальный счётчик загрузок PyPI — только публичный набор BigQuery (bigquery-public-data.pypi). pypistats.org — сторонний сервис.',
      conditions: ['Подключать только после чтения условий PyPI и набора данных'],
    },
    cost: 'Бесплатный уровень BigQuery — до 1 ТБ запросов в месяц; нужен проект Google Cloud',
    limits: {
      provider: 'Квота BigQuery проекта',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['пакет', 'дата', 'число загрузок', 'страна', 'установщик'],
      stored: [],
    },
    personalData: { risk: 'low', notes: 'Агрегаты по пакетам; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'pypi.org/policy/terms-of-use/ ведёт на policies.python.org — закрыт сетью среды, как и docs.pypi.org. По выдаче поиска с docs.pypi.org: таблицы под лицензией Creative Commons. Владельцу понадобится проект Google Cloud.',
    },
  },
  {
    key: 'google-ads-keyword-planner',
    name: 'Google Ads: Keyword Planner',
    siteUrl: 'https://ads.google.com',
    sourceKind: 'search_trends',
    access: {
      method: 'official_api',
      endpoint: 'https://googleads.googleapis.com',
      authentication: 'oauth',
    },
    terms: {
      urls: [
        'https://developers.google.com/google-ads/api/terms',
        'https://developers.google.com/google-ads/api/docs/access-levels',
      ],
      summary:
        'Google Ads API (KeywordPlanIdeaService): средний объём поиска в месяц по словам и странам. Нужны управляющий аккаунт и токен разработчика.',
      conditions: ['Подключать только после чтения условий API и одобрения токена (Basic)'],
    },
    cost: 'API бесплатно; управляющий аккаунт Google Ads, токен разработчика, OAuth',
    limits: {
      provider: 'Basic — до 15 000 операций в сутки (по выдаче поиска)',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['ключевое слово', 'объём поиска в месяц', 'конкуренция', 'диапазон ставок'],
      stored: [],
    },
    personalData: { risk: 'low', notes: 'Агрегаты по запросам; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'developers.google.com закрыт сетью среды. По выдаче поиска: токен без одобрения работает только с тестовыми аккаунтами; Keyword Planner может требовать аккаунт со способом оплаты — проверить. Владелец: управляющий аккаунт и токен разработчика (Basic).',
    },
  },
  {
    key: 'us-census',
    name: 'US Census: County Business Patterns',
    siteUrl: 'https://www.census.gov',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.census.gov/data',
      authentication: 'api_key',
    },
    terms: {
      urls: [
        'https://census.gov/data/developers/terms-of-service.html',
        'https://www.census.gov/data/developers/guidance/api-user-guide.API_Key.html',
      ],
      summary:
        'Census Data API: число компаний, работников и фонд оплаты по отраслям NAICS и регионам США — размер рынка.',
      conditions: [
        'Подключать только после чтения условий',
        'Показывать уведомление, которого требуют условия',
      ],
    },
    cost: 'Бесплатно, ключ по e-mail',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: {
      provided: ['отрасль NAICS', 'регион', 'число компаний', 'работники', 'фонд оплаты'],
      stored: [],
    },
    personalData: {
      risk: 'low',
      notes: 'Агрегаты; закон США запрещает публиковать данные, по которым узнаётся респондент.',
    },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'census.gov закрыт сетью среды. По выдаче поиска: ключ обязателен для всех запросов; условия разрешают сервисы, которые ищут, показывают и анализируют данные, с уведомлением в приложении. Владелец: ключ на api.census.gov/data/key_signup.html.',
    },
  },
  {
    key: 'us-bls',
    name: 'US BLS: занятость и зарплаты',
    siteUrl: 'https://www.bls.gov',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.bls.gov/publicAPI/v2',
      authentication: 'api_key',
    },
    terms: {
      urls: [
        'https://www.bls.gov/developers/termsOfService.htm',
        'https://www.bls.gov/developers/api_faqs.htm',
      ],
      summary:
        'BLS Public Data API: занятость и зарплаты по профессиям и отраслям США — размер рынка по людям.',
      conditions: ['Подключать только после чтения условий'],
    },
    cost: 'Бесплатно, ключ по e-mail; продлевать раз в год',
    limits: {
      provider:
        'С ключом: 500 запросов в сутки, 50 рядов в запросе, 50 запросов за 10 секунд (FAQ, по выдаче поиска)',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: { provided: ['ряд', 'период', 'значение'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'bls.gov закрыт сетью среды; текст условий не прочитан. Владелец: ключ на data.bls.gov/registrationEngine/.',
    },
  },
  {
    key: 'uk-ons',
    name: 'UK ONS: статистика',
    siteUrl: 'https://www.ons.gov.uk',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.beta.ons.gov.uk/v1',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://developer.ons.gov.uk/',
        'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
      ],
      summary:
        'ONS API (бета): наборы статистики Великобритании — компании и занятость по отраслям.',
      conditions: ['Подключать только после проверки лицензии данных'],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['набор данных', 'измерения', 'значения'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['GB'],
    languages: ['en'],
    evidenceMarket: 'GB',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'developer.ons.gov.uk закрыт сетью среды. По выдаче поиска: API открыт, без ключа, в бете. Лицензию данных проверить (ожидается Open Government Licence v3).',
    },
  },
  {
    key: 'uk-companies-house',
    name: 'UK Companies House',
    siteUrl: 'https://find-and-update.company-information.service.gov.uk',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.company-information.service.gov.uk',
      authentication: 'api_key',
    },
    terms: {
      urls: [
        'https://developer.company-information.service.gov.uk/developer-guidelines',
        'https://developer-specs.company-information.service.gov.uk/guides/rateLimiting',
      ],
      summary:
        'Public Data API реестра компаний Великобритании: поиск по коду отрасли SIC — число компаний для размера рынка.',
      conditions: [
        'Подключать только после чтения условий',
        'Не запрашивать должностных лиц; хранить только счётчики по SIC',
      ],
    },
    cost: 'Бесплатно, ключ после регистрации',
    limits: {
      provider: '600 запросов за 5 минут на приложение (developer guidelines, по выдаче поиска)',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['компании', 'коды SIC', 'статус', 'адрес', 'должностные лица'],
      stored: [],
    },
    personalData: {
      risk: 'medium',
      notes: 'Имена должностных лиц и адреса; названия ИП бывают именами людей.',
    },
    markets: ['GB'],
    languages: ['en'],
    evidenceMarket: 'GB',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'developer.company-information.service.gov.uk закрыт сетью среды. Владелец: аккаунт разработчика Companies House и ключ (бесплатно).',
    },
  },
  {
    key: 'statistics-canada',
    name: 'Statistics Canada',
    siteUrl: 'https://www.statcan.gc.ca',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://www150.statcan.gc.ca/t1/wds/rest',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://statcan.gc.ca/reference/licence',
        'https://statcan.gc.ca/eng/reference/licence-faq',
      ],
      summary:
        'Web Data Service: таблицы Statistics Canada — компании и занятость по отраслям Канады. Данные — под Statistics Canada Open Licence.',
      conditions: [
        'Подключать только после чтения лицензии',
        'Указывать «Source: Statistics Canada, название, дата»',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['таблица', 'измерения', 'значения'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['CA'],
    languages: ['en'],
    evidenceMarket: 'CA',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'statcan.gc.ca закрыт сетью среды. По выдаче поиска с официальной страницы лицензии: всемирная бесплатная лицензия, в том числе для коммерческого использования, с указанием источника. Кандидат на allowed после чтения.',
    },
  },
  {
    key: 'abs-australia',
    name: 'Australian Bureau of Statistics',
    siteUrl: 'https://www.abs.gov.au',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.data.abs.gov.au',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://www.abs.gov.au/about/data-services/application-programming-interfaces-apis/data-api-user-guide',
        'https://www.abs.gov.au/website-privacy-copyright-and-disclaimer',
      ],
      summary: 'ABS Data API: статистика Австралии — компании и занятость по отраслям.',
      conditions: ['Подключать только после чтения условий и лицензии'],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['набор данных', 'измерения', 'значения'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['AU'],
    languages: ['en'],
    evidenceMarket: 'AU',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'abs.gov.au закрыт сетью среды. По выдаче поиска: наборы ABS на data.gov.au помечены CC BY 3.0 AU; лицензия самого Data API не подтверждена.',
    },
  },
  {
    key: 'gdelt',
    name: 'GDELT: новости',
    siteUrl: 'https://www.gdeltproject.org',
    sourceKind: 'news',
    access: {
      method: 'official_api',
      endpoint: 'https://api.gdeltproject.org/api/v2/doc/doc',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.gdeltproject.org/about.html'],
      summary: 'GDELT DOC API: новости мира по запросу — контекст рынка.',
      conditions: [
        'Подключать только после чтения условий',
        'Указывать GDELT как источник со ссылкой',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не проверено', minIntervalMinutes: 360, maxItemsPerRun: 30 },
    dataFields: {
      provided: ['заголовок', 'ссылка', 'домен', 'дата', 'язык', 'страна источника'],
      stored: [],
    },
    personalData: {
      risk: 'low',
      notes: 'В заголовках бывают имена людей — вычищать до записи, как у Evidence.',
    },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'gdeltproject.org закрыт сетью среды. Сторонний блог цитирует условия: «all datasets released by the GDELT Project are available for unlimited and unrestricted use» — с указанием источника и ссылкой. Кандидат на allowed после чтения.',
    },
  },
  {
    key: 'federal-register',
    name: 'Federal Register',
    siteUrl: 'https://www.federalregister.gov',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://www.federalregister.gov/api/v1',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://www.federalregister.gov/reader-aids/developer-resources/rest-api',
        'https://www.federalregister.gov/developers/documentation/api/v1',
      ],
      summary:
        'Federal Register API: новые правила и уведомления федеральных агентств США — регуляторный контекст.',
      conditions: ['Подключать только после чтения условий'],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Не проверено; выдача — первые 2 000 результатов запроса',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['заголовок', 'агентство', 'тип документа', 'дата', 'аннотация', 'ссылка'],
      stored: [],
    },
    personalData: { risk: 'low', notes: 'Официальные документы; имена должностных лиц не берём.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'federalregister.gov закрыт сетью среды. По выдаче поиска с официальной страницы: ключ не нужен, ответы в JSON и CSV.',
    },
  },
  {
    key: 'sec-edgar',
    name: 'SEC EDGAR',
    siteUrl: 'https://www.sec.gov',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://data.sec.gov',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.sec.gov/os/accessing-edgar-data'],
      summary:
        'EDGAR API: отчётность публичных компаний США (выручка, сегменты) — контекст и размер рынка.',
      conditions: [
        'Подключать только после чтения условий',
        'User-Agent с названием и контактным e-mail; только нужные документы',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: '10 запросов в секунду (официальная страница, по выдаче поиска)',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 30,
    },
    dataFields: { provided: ['компания', 'форма отчёта', 'дата', 'показатели XBRL'], stored: [] },
    personalData: { risk: 'low', notes: 'Отчёты компаний; имена руководителей не берём.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'sec.gov закрыт сетью среды. По выдаче поиска с официальной страницы: до 10 запросов в секунду, заголовок с контактом, «download only what you need». Контакт в User-Agent — PUBLIC_CONTACT_EMAIL.',
    },
  },
  {
    key: 'youtube',
    name: 'YouTube: комментарии',
    siteUrl: 'https://www.youtube.com',
    sourceKind: 'social',
    access: {
      method: 'official_api',
      endpoint: 'https://www.googleapis.com/youtube/v3',
      authentication: 'api_key',
    },
    terms: {
      urls: [
        'https://developers.google.com/youtube/terms/api-services-terms-of-service',
        'https://developers.google.com/youtube/terms/developer-policies',
      ],
      summary:
        'YouTube Data API: комментарии под видео о проблемах — боли. Developer Policies ограничивают хранение и агрегирование данных API.',
      conditions: ['Подключать только после чтения условий и правил разработчика'],
    },
    cost: 'Бесплатно в пределах дневной квоты проекта Google Cloud',
    limits: {
      provider: 'Дневная квота единиц на проект',
      minIntervalMinutes: 360,
      maxItemsPerRun: 30,
    },
    dataFields: { provided: ['видео', 'комментарии', 'имена каналов авторов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена и каналы авторов комментариев.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'developers.google.com закрыт сетью среды. По выдаче поиска: правила требуют ограничивать срок хранения, запрещают некоторые виды агрегирования и содержат раздел о коммерческом использовании с формой одобрения. Проверить, разрешён ли анализ комментариев.',
    },
  },
  {
    key: 'dev-to',
    name: 'DEV Community',
    siteUrl: 'https://dev.to',
    sourceKind: 'forum',
    access: {
      method: 'official_api',
      endpoint: 'https://dev.to/api',
      authentication: 'none',
    },
    terms: {
      urls: ['https://dev.to/terms', 'https://developers.forem.com/api/v1'],
      summary: 'Forem API: статьи и комментарии DEV Community — боли разработчиков.',
      conditions: ['Подключать только после чтения условий'],
    },
    cost: 'Бесплатно; чтение без ключа',
    limits: { provider: 'Не проверено', minIntervalMinutes: 60, maxItemsPerRun: 30 },
    dataFields: { provided: ['статьи', 'комментарии', 'теги', 'имена авторов'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена и профили авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'dev.to и developers.forem.com закрыты сетью среды. По выдаче поиска: публичное чтение статей и комментариев — без ключа. Аудитория — разработчики, как у Hacker News.',
    },
  },
  {
    key: 'mastodon-social',
    name: 'Mastodon (mastodon.social)',
    siteUrl: 'https://mastodon.social',
    sourceKind: 'social',
    access: {
      method: 'official_api',
      endpoint: 'https://mastodon.social/api/v1',
      authentication: 'none',
    },
    terms: {
      urls: ['https://mastodon.social/terms'],
      summary:
        'Флагманский сервер Mastodon. У каждого сервера федерации свои условия; эта запись — только о mastodon.social.',
      conditions: [
        'Не подключать до чтения условий: по сообщениям прессы, с 01.07.2025 условия запрещают автоматический сбор данных',
      ],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Не проверено', minIntervalMinutes: 60, maxItemsPerRun: 30 },
    dataFields: { provided: ['посты', 'хэштеги', 'имена и аккаунты авторов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена и аккаунты авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'mastodon.social закрыт сетью среды. TechCrunch (17.06.2025): новые условия запрещают сбор данных скрейперами и data miners, кроме поисковиков и людей. Вероятно rejected; другие серверы — каждый по своим условиям.',
    },
  },
  {
    key: 'app-store-reviews',
    name: 'App Store: отзывы',
    siteUrl: 'https://apps.apple.com',
    sourceKind: 'review_site',
    access: {
      method: 'rss',
      endpoint: 'https://itunes.apple.com',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.apple.com/legal/internet-services/itunes/'],
      summary:
        'RSS-лента отзывов о приложениях App Store по странам — боли пользователей. Официальных условий для ленты отзывов не найдено.',
      conditions: ['Не подключать, пока не найдены официальные условия ленты'],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['оценка', 'заголовок', 'текст отзыва', 'имя автора'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена авторов отзывов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'apple.com закрыт сетью среды; поиск не нашёл официальных условий ленты отзывов. App Store Connect API даёт отзывы только о своих приложениях.',
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
