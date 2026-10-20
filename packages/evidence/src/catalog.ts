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
      urls: [
        'https://stackoverflow.com/legal/api-terms-of-use',
        'https://stackoverflow.com/legal/acceptable-use-policy',
        'https://stackoverflow.com/legal/terms-of-service/public',
      ],
      summary:
        'API бесплатно, с указанием источника. Acceptable Use Policy запрещает автоматический сбор для AI-систем без письменного согласия, а боли в ROI Dealer извлекают AI-агенты.',
      conditions: [
        'Не подключать без письменного согласия Stack Exchange (Stack Data Licensing)',
        'При подключении — указывать Stack Exchange источником, не больше 30 запросов в секунду с IP',
      ],
    },
    cost: 'API бесплатно; лицензия данных — по договору',
    limits: {
      provider:
        'До 10 000 запросов в сутки на ключ; больше 30 запросов в секунду с IP — бан; одинаковый запрос — не чаще раза в минуту',
      minIntervalMinutes: 60,
      maxItemsPerRun: 30,
    },
    dataFields: { provided: ['вопросы', 'ответы', 'теги', 'ники авторов'], stored: [] },
    personalData: { risk: 'medium', notes: 'Ники и ссылки на профили.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'AUP, Content Scraping/Bot Policy: сбор запрещён «for the purpose of… Developing, building, training, testing, indexing, benchmarking, or improving any generative AI… tool, model, or platform»; исключение — «express prior written consent… as part of a commercial license agreement». API Terms требуют только атрибуцию. Боли извлекает AI — нужен договор.',
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
        'https://docs.bsky.app/docs/developer-guidelines',
        'https://bsky.social/about/support/tos',
        'https://docs.bsky.app/docs/bluesky-api',
      ],
      summary:
        'Открытый протокол AT. Условия и Developer Guidelines не запрещают читать публичные посты для анализа; поиск постов — после входа с паролем приложения (app password).',
      conditions: [
        "Только чтение: никаких автоматических лайков, подписок, ответов и сообщений (Developer Guidelines: Don't spam)",
        'До подключения — способ удалить сохранённый фрагмент по просьбе автора',
        'Публичный контакт с почтой — PUBLIC_CONTACT_EMAIL',
        'Без хендлов, DID и ссылок на профили; текст — после очистки персональных данных',
      ],
    },
    cost: 'Бесплатно; нужен аккаунт Bluesky и пароль приложения',
    limits: {
      provider: 'Лимиты по IP и аккаунту; поиск без входа закрыт (403)',
      minIntervalMinutes: 60,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['посты', 'хендлы', 'DID'],
      stored: ['текст поста (очищенный)', 'время', 'ссылка на пост'],
    },
    personalData: {
      risk: 'high',
      notes: 'Хендлы и DID — идентификаторы людей: не сохраняются; имена в тексте вычищаются.',
    },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Developer Guidelines: «All services must have a method for deleting content a user has requested to be deleted»; «Developers must maintain updated contact information… including an email address». Запретов на чтение публичных постов в Terms of Service и Guidelines нет. Bluesky API: «bots and command-line tools can stick with passwords».',
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
      summary: 'GraphQL API Product Hunt: по умолчанию только некоммерческое использование.',
      conditions: ['Не подключать без разрешения Product Hunt (hello@producthunt.com)'],
    },
    cost: 'Бесплатно для некоммерческого использования; для бизнеса — по договорённости',
    limits: { provider: 'Квота сложности запросов', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['продукты', 'описания', 'голоса', 'комментарии'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена и профили создателей.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Документация API: «The Product Hunt API must not be used for commercial purposes. If you would like to use it for your business, please contact us at hello@producthunt.com». Страница producthunt.com/terms закрыта для автоматических запросов (403).',
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
        'Официальный API — альфа-тест по заявке; неофициальные библиотеки и сервисы выгрузки — скрейпинг.',
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
        "Официальная страница: «We're now accepting applications for alpha testers»; «As we can't open the API for everyone yet, we're prioritizing…». Владелец подал заявку 2026-10-20. После одобрения — прочитать условия доступа, затем ключ — в Variables сервиса worker.",
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
        'Analytics API: просмотры статей Википедии по дням, без ключа — интерес к теме. Данные под CC0.',
      conditions: [
        'User-Agent с названием, версией и контактом (PUBLIC_CONTACT_EMAIL)',
        'Запросы последовательно: следующий — после ответа на предыдущий',
        'Коннектор — после решения о хранении рядов спроса (05b)',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Зависят от клиента; без User-Agent — блокировка без предупреждения',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['статья', 'дата', 'число просмотров', 'тип доступа и агента'],
      stored: ['статья, дата, число просмотров'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты по статьям; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        "Access policy: «By using the API, you agree to Wikimedia's terms of use»; «Data provided by the API is available under the CC0 1.0 license»; «wait for each request to finish before sending another request». CC0 не ограничивает коммерческое использование.",
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
        'https://policies.python.org/pypi.org/Terms-of-Service/',
        'https://github.com/pypi/warehouse/blob/main/docs/user/api/bigquery.md',
      ],
      summary:
        'Официальный счётчик загрузок PyPI — публичный набор BigQuery bigquery-public-data.pypi под CC BY 4.0. pypistats.org — сторонний сервис, не используем.',
      conditions: [
        'Только через BigQuery своего проекта Google Cloud, в пределах бесплатного уровня',
        'Указывать PyPI источником (CC BY 4.0)',
        'Коннектор — после решения о хранении рядов спроса (05b)',
      ],
    },
    cost: 'Бесплатный уровень BigQuery — до 1 ТБ запросов в месяц; нужен проект Google Cloud',
    limits: {
      provider: 'Квота BigQuery проекта',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['пакет', 'дата', 'число загрузок', 'страна', 'установщик'],
      stored: ['пакет, дата, число загрузок'],
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
        'Документация набора (pypi/warehouse): «The tables and its pertaining data are licensed under the Creative Commons License» (CC BY 4.0). PyPI Terms of Service, API Terms: запрещены злоупотребление частотой и выгрузка «for spamming purposes». docs.pypi.org закрыт сетью среды — прочитан исходник документации на GitHub.',
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
        'Google Ads API (KeywordPlanIdeaService): объём поиска в месяц по словам и странам. С 09.09.2026 токенов разработчика нет — уровень доступа выдаётся проекту Google Cloud.',
      conditions: [
        'Нужен доступ Basic с разрешённым использованием «keyword research» — заявка, рассмотрение около 10 рабочих дней',
        'Не превышать квоты и не скрывать активность (Usage and Quotas)',
      ],
    },
    cost: 'API бесплатно; аккаунт Google Ads, проект Google Cloud, OAuth',
    limits: {
      provider: 'Basic — 15 000 операций в сутки; Explorer — 2 880, но без Keyword Planning',
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
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Access levels: «Developer tokens were sunset on September 9, 2026, and API access levels are now managed per Google Cloud project». Explorer выдаётся автоматически, но «restricts access to the following features… Planning: KeywordPlanIdeaService» — нужен Basic по заявке, то есть одобрение Google.',
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
        'Показывать: «This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.»',
        'Не изменять данные, оставляя Census источником',
        'Коннектор — после решения о хранении рядов (05b)',
      ],
    },
    cost: 'Бесплатно, ключ по e-mail',
    limits: {
      provider: 'Не заявлены; Census вправе ограничить',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['отрасль NAICS', 'регион', 'число компаний', 'работники', 'фонд оплаты'],
      stored: ['отрасль, регион, год, показатели'],
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
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Service: «You may use the Census Bureau API to develop a service or service to search, display, analyze, retrieve, view and otherwise "get" information from Census Bureau data». Нужна оговорка о неодобрении Census. Ключ бесплатный: api.census.gov/data/key_signup.html.',
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
      conditions: [
        'Указывать дату получения данных',
        'Писать: «BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.»',
        'Без логотипа BLS',
      ],
    },
    cost: 'Бесплатно, ключ по e-mail; продлевать раз в год',
    limits: {
      provider:
        'С ключом: 500 запросов в сутки, 50 рядов в запросе, 20 лет; 50 запросов за 10 секунд',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: { provided: ['ряд', 'период', 'значение'], stored: ['ряд, период, значение'] },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Service: «Data accessed through BLS.gov do not, and should not, include controls over its end use». Условия — дата получения и оговорка о достоверности. Ключ v2 бесплатный: data.bls.gov/registrationEngine/.',
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
        'ONS API (бета): наборы статистики Великобритании — компании и занятость по отраслям. Open Government Licence v3.0.',
      conditions: [
        'Указывать: «Contains public sector information licensed under the Open Government Licence v3.0.»',
        'API в бете: возможны несовместимые изменения',
        'Коннектор — после решения о хранении рядов (05b)',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: {
      provided: ['набор данных', 'измерения', 'значения'],
      stored: ['набор данных, измерения, значения'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['GB'],
    languages: ['en'],
    evidenceMarket: 'GB',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'developer.ons.gov.uk: «The API is open and unrestricted - no API keys are required»; «All content is available under the Open Government Licence v3.0». OGL: можно «exploit the Information commercially and non-commercially… including it in your own product or application» с указанием источника.',
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
        'Подключать только после проверки лицензии данных',
        'Не запрашивать должностных лиц; хранить только счётчики по SIC',
      ],
    },
    cost: 'Бесплатно, ключ после регистрации',
    limits: {
      provider: '600 запросов за 5 минут на приложение; за обход — бан без предупреждения',
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
        'Developer guidelines прочитаны: «You can make up to 600 requests within a 5 minute period». Лицензию данных на сайтах Companies House не нашёл; на их форуме — разные мнения (OGL или публикация по закону). Проверить при следующем запуске.',
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
      urls: ['https://statcan.gc.ca/reference/licence'],
      summary:
        'Web Data Service: таблицы Statistics Canada — компании и занятость по отраслям Канады. Statistics Canada Open Licence.',
      conditions: [
        'Указывать «Source: Statistics Canada, название, дата»',
        'Не связывать данные с другими базами, чтобы узнать конкретного человека или компанию',
        'Коннектор — после решения о хранении рядов (05b)',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: {
      provided: ['таблица', 'измерения', 'значения'],
      stored: ['таблица, измерения, значения'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['CA'],
    languages: ['en'],
    evidenceMarket: 'CA',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Statistics Canada Open Licence: «grants you a worldwide, royalty-free, non-exclusive licence to: use, reproduce, publish, freely distribute, or sell the Information». Условия — точность, указание источника, без намёка на одобрение Statistics Canada.',
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
      summary: 'ABS Data API: статистика Австралии — компании и занятость по отраслям. CC BY 4.0.',
      conditions: [
        'Указывать ABS источником (CC BY 4.0)',
        'Коннектор — после решения о хранении рядов (05b)',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: {
      provided: ['набор данных', 'измерения', 'значения'],
      stored: ['набор данных, измерения, значения'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['AU'],
    languages: ['en'],
    evidenceMarket: 'AU',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Copyright: «All material presented on this website is provided under a Creative Commons Attribution 4.0 International licence» (кроме герба, логотипа, микроданных и материалов третьих лиц). Data API user guide: «The Data API is freely accessible without the need for an API key».',
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
        'Указывать GDELT Project со ссылкой на gdeltproject.org',
        'Заголовки — после очистки персональных данных',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 360, maxItemsPerRun: 30 },
    dataFields: {
      provided: ['заголовок', 'ссылка', 'домен', 'дата', 'язык', 'страна источника'],
      stored: ['заголовок (очищенный)', 'домен', 'дата', 'ссылка'],
    },
    personalData: {
      risk: 'low',
      notes: 'В заголовках бывают имена людей — вычищаются до записи, как у Evidence.',
    },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'About, Terms of Use: «all datasets released by the GDELT Project are available for unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee»; «any use or redistribution of the data must include a citation to the GDELT Project and a link to this website».',
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
      urls: ['https://www.federalregister.gov/reader-aids/developer-resources/rest-api'],
      summary:
        'Federal Register API: новые правила и уведомления федеральных агентств США — регуляторный контекст.',
      conditions: [
        'Только API: страницы сайта закрыты для программ',
        'User-Agent с названием и контактом',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Выдача — первые 2 000 результатов запроса',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['заголовок', 'агентство', 'тип документа', 'дата', 'аннотация', 'ссылка'],
      stored: ['заголовок', 'агентство', 'тип документа', 'дата', 'ссылка'],
    },
    personalData: { risk: 'low', notes: 'Официальные документы; имена должностных лиц не берём.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Сайт отвечает программам: «programmatic access to these sites is limited to access to our extensive developer APIs». API работает без ключа (проверено 2026-10-20). Документы Federal Register — официальные публикации правительства США.',
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
      urls: [
        'https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data',
        'https://www.sec.gov/privacy',
      ],
      summary:
        'EDGAR API: отчётность публичных компаний США (выручка, сегменты) — контекст и размер рынка.',
      conditions: [
        'User-Agent: название и контактная почта (PUBLIC_CONTACT_EMAIL)',
        'Не больше 10 запросов в секунду, только нужные документы',
        'Указывать SEC источником',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: '10 запросов в секунду; без заявленного User-Agent — блокировка',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['компания', 'форма отчёта', 'дата', 'показатели XBRL'],
      stored: ['компания', 'форма отчёта', 'дата', 'показатели'],
    },
    personalData: { risk: 'low', notes: 'Отчёты компаний; имена руководителей не берём.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        "Accessing EDGAR Data: «Anyone can access and download this information for free»; «Current max request rate: 10 requests/second»; «Please declare your user agent». Privacy: «Information presented on sec.gov is considered public information and may be copied or further distributed… without the SEC's permission».",
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
        'YouTube Data API: комментарии под видео. Developer Policies запрещают агрегировать данные API и строить из них производные данные.',
      conditions: ['Не подключать: извлечение болей из комментариев — производные данные'],
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
      verdict: 'rejected',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Developer Policies: «Do not aggregate API Data»; «Your API Clients must not… access or use API Data to create new or derived data or metrics»; данные без авторизации — не дольше 30 дней. Извлечение болей из комментариев — производные данные.',
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
      urls: ['https://dev.to/terms'],
      summary:
        'Forem API: статьи и комментарии DEV Community. Условия сайта разрешают только личный некоммерческий просмотр.',
      conditions: ['Не подключать без письменного разрешения DEV'],
    },
    cost: 'Бесплатно; чтение без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 60, maxItemsPerRun: 30 },
    dataFields: { provided: ['статьи', 'комментарии', 'теги', 'имена авторов'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена и профили авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms, Use License: только «for personal, non-commercial transitory viewing only»; нельзя «use the materials for any commercial purpose». Отдельных условий для API (Forem) нет.',
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
      urls: [
        'https://mastodon.social/terms',
        'https://blog.joinmastodon.org/2026/07/announcing-new-terms-of-service-for-our-servers/',
      ],
      summary:
        'Флагманский сервер Mastodon. Условия с 31.08.2026 — только для зарегистрированных пользователей; правила использования обещаны в декабре 2026.',
      conditions: ['Не подключать до публикации правил использования (декабрь 2026)'],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 60, maxItemsPerRun: 30 },
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
        'Условия (ред. 31.08.2026, через API сервера) запретов на чтение не содержат: «Anyone, or any computer, might access your Content via RSS aggregators… or index and store your Content in search engines and databases». Правила использования обещаны в декабре 2026; условия 2025 года запрещали автоматический сбор. Перепроверить в январе 2027.',
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
        'Лента отзывов о приложениях App Store. Условия Apple Media Services запрещают автоматический анализ контента.',
      conditions: ['Не подключать'],
    },
    cost: 'Бесплатно',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['оценка', 'заголовок', 'текст отзыва', 'имя автора'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена авторов отзывов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Apple Media Services Terms: «You may not use any software, device, automated process… to scrape, copy, or perform measurement, analysis, or monitoring of, any portion of the Content or Services»; Services — «only for personal, noncommercial purposes». App Store Connect API даёт отзывы только о своих приложениях.',
    },
  },
  {
    key: 'world-bank',
    name: 'World Bank: показатели',
    siteUrl: 'https://data.worldbank.org',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.worldbank.org/v2',
      authentication: 'none',
    },
    terms: {
      urls: [
        'https://datacatalog.worldbank.org/public-licenses',
        'https://www.worldbank.org/en/about/legal/terms-and-conditions',
      ],
      summary:
        'Indicators API: экономические показатели по странам. Наборы по умолчанию под CC BY 4.0; у части — свои лицензии.',
      conditions: [
        'Указывать World Bank источником; лицензию проверять по каждому набору',
        'Роль слабая: показатели по странам целиком, размер ниши из них не посчитать',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: {
      provided: ['страна', 'показатель', 'год', 'значение'],
      stored: ['страна, показатель, год, значение'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты по странам; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Data Catalog, Public licenses: «licenses datasets under the Creative Commons Attribution 4.0 International license (CC-BY 4.0)»; CC BY 4.0 «allows users to copy, modify and distribute data in any format for any purpose, including commercial use». Наборы с другой лицензией помечены отдельно.',
    },
  },
  {
    key: 'eurostat',
    name: 'Eurostat',
    siteUrl: 'https://ec.europa.eu/eurostat',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://ec.europa.eu/eurostat/api/dissemination',
      authentication: 'none',
    },
    terms: {
      urls: ['https://ec.europa.eu/eurostat/help/copyright-notice'],
      summary:
        'Статистика ЕС: компании и занятость по отраслям. Коммерческое использование разрешено с указанием источника.',
      conditions: [
        'Указывать Eurostat источником и отмечать изменения',
        'Коммерчески не использовать данные не Eurostat — например, по США, Японии, Китаю',
        'Рынки ЕС вне D-008: подключать при расширении рынков',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: {
      provided: ['набор данных', 'измерения', 'значения'],
      stored: ['набор данных, измерения, значения'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['DE', 'FR', 'IT', 'ES', 'NL', 'IE', 'SE', 'PL'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Copyright notice: «Reuse of statistical data, metadata, publications, and other dissemination tools published on this website for commercial or non-commercial purposes is authorised provided the source is acknowledged». Исключения — данные из других источников, например по США.',
    },
  },
  {
    key: 'arxiv',
    name: 'arXiv: метаданные статей',
    siteUrl: 'https://arxiv.org',
    sourceKind: 'other',
    access: {
      method: 'official_api',
      endpoint: 'https://export.arxiv.org/api/query',
      authentication: 'none',
    },
    terms: {
      urls: ['https://info.arxiv.org/help/api/tou.html'],
      summary:
        'API arXiv: метаданные научных препринтов — контекст: новые технологии по теме. Метаданные под CC0.',
      conditions: [
        'Только метаданные: полные тексты — с разрешения правообладателя',
        'Соблюдать лимиты частоты из условий API',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Лимиты частоты — в разделе Rate limits условий API',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['заголовок', 'аннотация', 'авторы', 'категория', 'дата'],
      stored: ['заголовок', 'аннотация', 'категория', 'дата', 'ссылка'],
    },
    personalData: { risk: 'low', notes: 'Имена авторов не сохраняются.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Use for arXiv APIs: «You are free to use descriptive metadata about arXiv e-prints under the terms of the Creative Commons Universal (CC0 1.0) Public Domain Declaration»; «The redistribution of e-prints requires permission from the copyright holder». Роль слабая — контекст.',
    },
  },
  {
    key: 'openalex',
    name: 'OpenAlex: исследования',
    siteUrl: 'https://openalex.org',
    sourceKind: 'other',
    access: {
      method: 'official_api',
      endpoint: 'https://api.openalex.org',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://help.openalex.org/access/pricing/'],
      summary:
        'Индекс научных работ: темы, организации, рост числа публикаций — контекст. Данные под CC0.',
      conditions: ['Только бесплатный дневной бюджет API ($1 в день)'],
    },
    cost: 'Бесплатно до $1 использования API в день; ключ бесплатный',
    limits: {
      provider: '$1 использования в день на бесплатном ключе',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['работы', 'темы', 'организации', 'авторы', 'цитирования'],
      stored: ['тема, год, число работ'],
    },
    personalData: { risk: 'low', notes: 'Имена авторов не сохраняются.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Pricing: «the data is a public good, released under a CC0 public-domain license with no "personal use only" carve-out and no permission to ask»; «every account gets $1 of API usage per day for free». Роль слабая — контекст.',
    },
  },
  {
    key: 'crossref',
    name: 'Crossref: метаданные публикаций',
    siteUrl: 'https://www.crossref.org',
    sourceKind: 'other',
    access: {
      method: 'official_api',
      endpoint: 'https://api.crossref.org',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.crossref.org/documentation/retrieve-metadata/rest-api/'],
      summary: 'REST API Crossref: метаданные научных публикаций — контекст.',
      conditions: [
        'Передавать mailto в запросе (polite pool)',
        'Аннотации могут быть под авторским правом — не сохранять',
      ],
    },
    cost: 'Бесплатно, без регистрации',
    limits: {
      provider: 'Не заявлены; polite pool с mailto',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['работы', 'журналы', 'издатели', 'аннотации'],
      stored: ['тема, год, число работ'],
    },
    personalData: { risk: 'low', notes: 'Имена авторов не сохраняются.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'REST API: «No sign-up is required to use the REST API, and almost none of the metadata is subject to copyright, and you may use it for any purpose. Some abstracts contained in the metadata may be subject to copyright». Роль слабая — контекст.',
    },
  },
  {
    key: 'x-api',
    name: 'X (Twitter)',
    siteUrl: 'https://x.com',
    sourceKind: 'social',
    access: {
      method: 'official_api',
      endpoint: 'https://api.x.com/2',
      authentication: 'api_key',
    },
    terms: {
      urls: [
        'https://developer.x.com/en/developer-terms/agreement-and-policy',
        'https://docs.x.com/x-api/introduction',
      ],
      summary:
        'X API v2: посты по запросу — боли. Оплата за использование: кредиты покупаются заранее.',
      conditions: [
        'Каждая покупка кредитов — трата, одобряемая владельцем (D-007, порог $20)',
        'Удалять пост в течение 24 часов после его удаления на X',
      ],
    },
    cost: 'Оплата за использование, кредиты заранее',
    limits: { provider: 'По купленным кредитам', minIntervalMinutes: 360, maxItemsPerRun: 30 },
    dataFields: { provided: ['посты', 'имена и аккаунты авторов', 'метрики'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена, аккаунты и идентификаторы людей.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Developer Policy: планы Free, Basic, Pro «are designed for hobbyists, commercial prototyping, early-stage X product integrations»; хранимый контент — удалять «within 24 hours after receiving a request». Документация: «The X API uses pay-per-usage pricing». Нужна оплата — решение владельца.',
    },
  },
  {
    key: 'quora',
    name: 'Quora',
    siteUrl: 'https://www.quora.com',
    sourceKind: 'forum',
    access: {
      method: 'manual',
      endpoint: 'https://www.quora.com',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.quora.com/about/tos'],
      summary: 'Вопросы и ответы — боли. Официального API для чтения не найдено.',
      conditions: ['Не подключать: без API остаётся только скрейпинг'],
    },
    cost: 'Не применимо',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['вопросы', 'ответы', 'имена авторов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена и профили авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'quora.com отвечает 403 на автоматические запросы — условия не прочитаны. Официального API для чтения не нашёл; если его нет, вердикт — rejected (только скрейпинг).',
    },
  },
  {
    key: 'indie-hackers',
    name: 'Indie Hackers',
    siteUrl: 'https://www.indiehackers.com',
    sourceKind: 'forum',
    access: {
      method: 'manual',
      endpoint: 'https://www.indiehackers.com',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.indiehackers.com/terms'],
      summary: 'Форум основателей — боли и выручка малых продуктов. Официального API не найдено.',
      conditions: ['Не подключать: без API остаётся только скрейпинг'],
    },
    cost: 'Не применимо',
    limits: { provider: 'Не заявлены', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['посты', 'комментарии', 'имена авторов'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена и профили авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'indiehackers.com отвечает 403 на автоматические запросы — условия не прочитаны. Официального API не нашёл; если его нет, вердикт — rejected (только скрейпинг).',
    },
  },
  {
    key: 'g2',
    name: 'G2: отзывы о софте',
    siteUrl: 'https://www.g2.com',
    sourceKind: 'review_site',
    access: {
      method: 'manual',
      endpoint: 'https://www.g2.com',
      authentication: 'agreement',
    },
    terms: {
      urls: ['https://legal.g2.com/terms-of-use'],
      summary: 'Отзывы о B2B-софте — боли бизнеса. Сбор данных — только с письменного согласия G2.',
      conditions: ['Не подключать без договора с G2'],
    },
    cost: 'По договору',
    limits: { provider: 'По договору', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['отзывы', 'оценки', 'имена и должности авторов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена, должности и компании авторов отзывов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Use §9: без «express prior written consent» нельзя «access, collect, copy, scrape, harvest, cache, index, store, archive, or otherwise extract any content or data from the Site, including user reviews». Только по договору с G2.',
    },
  },
  {
    key: 'capterra',
    name: 'Capterra: отзывы о софте',
    siteUrl: 'https://www.capterra.com',
    sourceKind: 'review_site',
    access: {
      method: 'manual',
      endpoint: 'https://www.capterra.com',
      authentication: 'agreement',
    },
    terms: {
      urls: ['https://www.capterra.com/legal/terms-of-use/'],
      summary:
        'Отзывы о софте для малого бизнеса — боли. Сбор данных — только с письменного согласия.',
      conditions: ['Не подключать без договора с Capterra (Gartner Digital Markets)'],
    },
    cost: 'По договору',
    limits: { provider: 'По договору', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['отзывы', 'оценки', 'имена и должности авторов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена, должности и компании авторов отзывов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Use §10: без «express prior written consent» нельзя «access, collect, copy, scrape, harvest, cache, index, store, archive, or otherwise extract any content or data from the Service, including user reviews». Только по договору.',
    },
  },
  {
    key: 'trustpilot',
    name: 'Trustpilot: отзывы',
    siteUrl: 'https://www.trustpilot.com',
    sourceKind: 'review_site',
    access: {
      method: 'official_api',
      endpoint: 'https://api.trustpilot.com/v1',
      authentication: 'agreement',
    },
    terms: {
      urls: [
        'https://legal.trustpilot.com/for-reviewers/end-user-terms-and-conditions',
        'https://developers.trustpilot.com/',
      ],
      summary:
        'Отзывы о компаниях — боли клиентов. Сбор контента — только с разрешения Trustpilot.',
      conditions: ['Не подключать без разрешения Trustpilot'],
    },
    cost: 'По договору',
    limits: { provider: 'По договору', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['отзывы', 'оценки', 'имена авторов'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена авторов отзывов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms: «You must not access, search or collect content from our platform by any means (automated or otherwise) except as provided on our platform or specifically approved by us»; text mining и scraping — только «with our express permission». Только с разрешения Trustpilot.',
    },
  },
  {
    key: 'google-play-reviews',
    name: 'Google Play: отзывы',
    siteUrl: 'https://play.google.com',
    sourceKind: 'review_site',
    access: {
      method: 'official_api',
      endpoint: 'https://androidpublisher.googleapis.com',
      authentication: 'oauth',
    },
    terms: {
      urls: ['https://developers.google.com/android-publisher/reply-to-reviews'],
      summary:
        'Официальный API отдаёт отзывы только о своих приложениях; отзывы о чужих — только скрейпингом.',
      conditions: ['Не подключать'],
    },
    cost: 'Бесплатно',
    limits: {
      provider: 'Квоты Google Play Developer API',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: { provided: ['отзывы о своих приложениях', 'оценки', 'имена авторов'], stored: [] },
    personalData: { risk: 'medium', notes: 'Имена авторов отзывов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Reply to Reviews API: «allows developers to view and reply to user feedback for their production apps» — только свои приложения. Отзывы о чужих приложениях официально не отдаются; сторонние библиотеки — скрейпинг.',
    },
  },
  {
    key: 'lemmy-world',
    name: 'Lemmy (lemmy.world)',
    siteUrl: 'https://lemmy.world',
    sourceKind: 'forum',
    access: {
      method: 'official_api',
      endpoint: 'https://lemmy.world/api/v3',
      authentication: 'none',
    },
    terms: {
      urls: ['https://legal.lemmy.world/tos/'],
      summary:
        'Крупнейший сервер Lemmy: сообщества по темам, похоже на Reddit — боли. Условия распространяются на API и не запрещают чтение.',
      conditions: [
        'Только чтение публичных постов: без ботов, голосов и сообщений',
        'Без ников и ссылок на профили; текст — после очистки персональных данных',
        'Только посты, созданные на lemmy.world: копии с других серверов Lemmy — под их собственными условиями',
      ],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Явных лимитов нет; robots.txt — Crawl-delay: 60, API не закрыт',
      minIntervalMinutes: 60,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['посты', 'комментарии', 'сообщества', 'ники авторов'],
      stored: ['заголовок + текст (очищенные)', 'время', 'ссылка на пост'],
    },
    personalData: {
      risk: 'medium',
      notes: 'Ники не сохраняются; контакты и имена в тексте вычищаются.',
    },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        "Terms of Service: «applies to your access to and active use of https://lemmy.world, it's API's»; «Users are allowed to use any provided method to interact with Lemmy.World, as long as it is in good faith». Правила для ботов касаются публикаций. Запрета на чтение и анализ нет.",
    },
  },
  {
    key: 'threads',
    name: 'Threads (Meta)',
    siteUrl: 'https://www.threads.com',
    sourceKind: 'social',
    access: {
      method: 'official_api',
      endpoint: 'https://graph.threads.net',
      authentication: 'oauth',
    },
    terms: {
      urls: [
        'https://developers.facebook.com/docs/threads/keyword-search',
        'https://developers.facebook.com/terms/',
      ],
      summary:
        'Threads API: поиск постов по словам — боли. Условия Meta Platform Terms не прочитаны.',
      conditions: ['Подключать только после чтения условий'],
    },
    cost: 'Не проверено',
    limits: { provider: 'Не проверено', minIntervalMinutes: 360, maxItemsPerRun: 30 },
    dataFields: { provided: ['посты', 'имена и аккаунты авторов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена и аккаунты авторов.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'developers.facebook.com отвечает 400 на автоматические запросы — условия и правила поиска по словам не прочитаны. Проверить: нужна ли проверка приложения Meta и разрешён ли анализ чужих постов.',
    },
  },
  {
    key: 'tumblr',
    name: 'Tumblr',
    siteUrl: 'https://www.tumblr.com',
    sourceKind: 'social',
    access: {
      method: 'official_api',
      endpoint: 'https://api.tumblr.com/v2',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://www.tumblr.com/docs/api_agreement'],
      summary: 'Tumblr API: посты по тегам. Хранить контент можно не дольше трёх дней.',
      conditions: ['Не подключать: доказательства в ROI Dealer хранятся бессрочно'],
    },
    cost: 'Бесплатно с ключом',
    limits: { provider: 'Лимиты API Tumblr', minIntervalMinutes: 360, maxItemsPerRun: 30 },
    dataFields: { provided: ['посты', 'теги', 'имена блогов'], stored: [] },
    personalData: { risk: 'high', notes: 'Имена блогов и личные истории.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'low',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'API Agreement: «Under no circumstances will you or your Licensee Applications store or cache Content for longer than three (3) days». Evidence в ROI Dealer — постоянная запись с историей, условие несовместимо.',
    },
  },
  {
    key: 'fred',
    name: 'FRED (ФРС Сент-Луиса)',
    siteUrl: 'https://fred.stlouisfed.org',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.stlouisfed.org/fred',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://fred.stlouisfed.org/docs/api/terms_of_use.html'],
      summary: 'FRED API: экономические ряды США — контекст рынка.',
      conditions: ['Подключать только после чтения условий'],
    },
    cost: 'Бесплатно, ключ после регистрации',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['ряд', 'дата', 'значение'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes: 'fred.stlouisfed.org закрыт сетью среды — условия не прочитаны.',
    },
  },
  {
    key: 'us-bea',
    name: 'US BEA: экономика по отраслям',
    siteUrl: 'https://www.bea.gov',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://apps.bea.gov/api/data',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://apps.bea.gov/API/_pdf/bea_api_tos.pdf'],
      summary: 'BEA API: ВВП и расходы по отраслям и штатам США — размер рынка.',
      conditions: [
        'Показывать: «This product uses the Bureau of Economic Analysis (BEA) Data API but is not endorsed or certified by BEA.»',
        'Не изменять данные, оставляя BEA источником',
        'Коннектор — после решения о хранении рядов (05b)',
      ],
    },
    cost: 'Бесплатно, ключ по e-mail',
    limits: {
      provider: 'Не заявлены; BEA вправе ограничить',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: {
      provided: ['таблица', 'отрасль', 'регион', 'год', 'значение'],
      stored: ['таблица, отрасль, регион, год, значение'],
    },
    personalData: { risk: 'low', notes: 'Агрегаты; людей в данных нет.' },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Service: «You may use the BEA API to develop a service or service to search, display, analyze, retrieve, view and otherwise "get" information from BEA data». Нужна оговорка о неодобрении BEA. Ключ бесплатный: apps.bea.gov/API/signup/.',
    },
  },
  {
    key: 'uk-nomis',
    name: 'UK Nomis: рынок труда',
    siteUrl: 'https://www.nomisweb.co.uk',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://www.nomisweb.co.uk/api/v01',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.nomisweb.co.uk/api/v01/help'],
      summary: 'Nomis API (ONS): занятость и компании по отраслям и районам Великобритании.',
      conditions: ['Подключать только после проверки лицензии данных'],
    },
    cost: 'Бесплатно, без ключа',
    limits: {
      provider: 'Число одновременных запросов ограничено; до 25 000 ячеек в выгрузке',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 50,
    },
    dataFields: { provided: ['набор данных', 'район', 'отрасль', 'значение'], stored: [] },
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
        'Справка API прочитана: «The number of concurrently running requests to the API is limited»; «You have a 25000 cell limit». Лицензию данных не нашёл: страница условий отвечает 404. Проверить при следующем запуске.',
    },
  },
  {
    key: 'regulations-gov',
    name: 'Regulations.gov',
    siteUrl: 'https://www.regulations.gov',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://api.regulations.gov/v4',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://open.gsa.gov/api/regulationsgov/'],
      summary:
        'Regulations.gov API: проекты правил США и публичные комментарии к ним — регуляторный контекст и жалобы компаний.',
      conditions: [
        'Только чтение (GET); Comment API для отправки комментариев не используем',
        'Комментарии — только после очистки персональных данных: в них имена',
      ],
    },
    cost: 'Бесплатно, ключ api.data.gov',
    limits: {
      provider: 'Лимиты ключа api.data.gov',
      minIntervalMinutes: 1_440,
      maxItemsPerRun: 30,
    },
    dataFields: {
      provided: ['документы', 'досье', 'комментарии', 'имена комментаторов'],
      stored: ['текст комментария (очищенный)', 'дата', 'ссылка'],
    },
    personalData: {
      risk: 'medium',
      notes: 'Имена комментаторов не сохраняются; имена и контакты в тексте вычищаются.',
    },
    markets: ['US'],
    languages: ['en'],
    evidenceMarket: 'US',
    defaultTrust: 'high',
    review: {
      verdict: 'allowed',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms of Participation касаются только отправки комментариев через Comment API. Для чтения ограничений нет: «Regulations.gov offers a GET API for documents, comments, dockets»; «The APIs allow for users to find creative ways to present regulatory data». Ключ бесплатный: api.data.gov.',
    },
  },
  {
    key: 'guardian',
    name: 'The Guardian: Open Platform',
    siteUrl: 'https://www.theguardian.com',
    sourceKind: 'news',
    access: {
      method: 'official_api',
      endpoint: 'https://content.guardianapis.com',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://www.theguardian.com/open-platform/terms-and-conditions'],
      summary: 'Статьи Guardian. Условия запрещают обработку AI и хранение дольше 24 часов.',
      conditions: ['Не подключать'],
    },
    cost: 'Бесплатный ключ для некоммерческого использования',
    limits: { provider: 'Лимиты ключа', minIntervalMinutes: 1_440, maxItemsPerRun: 30 },
    dataFields: { provided: ['статьи', 'заголовки', 'разделы', 'авторы'], stored: [] },
    personalData: { risk: 'low', notes: 'Имена авторов и героев статей.' },
    markets: ['GB', 'US', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'rejected',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Open Platform Terms: нельзя использовать контент «with any machine learning and/or artificial intelligence technologies to generate any data or content»; «you must not keep any OP Content for longer than 24 hours». Разбор в ROI Dealer — AI, доказательства хранятся бессрочно.',
    },
  },
  {
    key: 'newsapi',
    name: 'NewsAPI',
    siteUrl: 'https://newsapi.org',
    sourceKind: 'news',
    access: {
      method: 'official_api',
      endpoint: 'https://newsapi.org/v2',
      authentication: 'api_key',
    },
    terms: {
      urls: ['https://newsapi.org/terms', 'https://newsapi.org/pricing'],
      summary:
        'Агрегатор новостей. Бесплатный план — только для разработки; для работы — подписка от $449 в месяц.',
      conditions: ['Не подключать: подписка дороже лимитов D-007'],
    },
    cost: 'Подписка от $449 в месяц',
    limits: { provider: 'По подписке', minIntervalMinutes: 360, maxItemsPerRun: 30 },
    dataFields: { provided: ['заголовок', 'описание', 'источник', 'ссылка', 'дата'], stored: [] },
    personalData: { risk: 'low', notes: 'В заголовках бывают имена людей.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'medium',
    review: {
      verdict: 'needs_agreement',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Terms: Developer plan «may be used for development and testing in a development environment only, and cannot be used in a staging or production environment». Pricing: подписки $449 и $1749 в месяц — выше лимитов D-007. Для контекста есть бесплатный GDELT.',
    },
  },
  {
    key: 'microsoft-ads-keywords',
    name: 'Microsoft Advertising: объёмы поиска',
    siteUrl: 'https://ads.microsoft.com',
    sourceKind: 'search_trends',
    access: {
      method: 'official_api',
      endpoint: 'https://adinsight.api.bingads.microsoft.com',
      authentication: 'oauth',
    },
    terms: {
      urls: ['https://learn.microsoft.com/en-us/advertising/guides/get-started'],
      summary: 'Ad Insight API: оценки объёма поиска Bing по словам — спрос.',
      conditions: ['Подключать только после чтения условий доступа'],
    },
    cost: 'Не проверено',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['ключевое слово', 'объём поиска', 'конкуренция'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты по запросам; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes:
        'Страницы learn.microsoft.com собираются скриптом — текст условий API не получен. Проверить, что нужно для доступа к Ad Insight API и разрешено ли использовать оценки для исследования рынка.',
    },
  },
  {
    key: 'oecd',
    name: 'OECD: статистика',
    siteUrl: 'https://www.oecd.org',
    sourceKind: 'dataset',
    access: {
      method: 'official_api',
      endpoint: 'https://sdmx.oecd.org/public/rest',
      authentication: 'none',
    },
    terms: {
      urls: ['https://www.oecd.org/en/about/terms-conditions.html'],
      summary: 'OECD Data API: экономика и занятость по странам — контекст.',
      conditions: ['Подключать только после чтения условий'],
    },
    cost: 'Бесплатно, без ключа',
    limits: { provider: 'Не проверено', minIntervalMinutes: 1_440, maxItemsPerRun: 50 },
    dataFields: { provided: ['страна', 'показатель', 'период', 'значение'], stored: [] },
    personalData: { risk: 'low', notes: 'Агрегаты по странам; людей в данных нет.' },
    markets: ['US', 'GB', 'CA', 'AU'],
    languages: ['en'],
    defaultTrust: 'high',
    review: {
      verdict: 'needs_review',
      checkedBy: 'Claude (source scout, D-026)',
      checkedOn: '2026-10-20',
      notes: 'oecd.org отвечает 403 на автоматические запросы — условия не прочитаны.',
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
