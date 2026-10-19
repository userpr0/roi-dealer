# PHASE 05 REPORT — Evidence Engine

```text
Phase: 05 — Evidence Engine
Status: PASS
Date: 2026-10-18
Spec: docs/phases/05_evidence_engine.md (составлена Claude по решению владельца D-019)
Approval mode: D-020 — фазы до Уровня 2 одобрены; следующая — PHASE 09 AI Runtime
```

## Implemented

- **Каталог источников** — `@roi-dealer/evidence`, новый пакет:
  - 7 записей. По каждой записаны:
    - способ доступа и условия использования со ссылками;
    - стоимость и лимиты (наши: интервал и максимум за загрузку);
    - поля данных: что отдаёт источник и что храним;
    - риск персональных данных, рынки и язык, доверие;
    - кто и когда проверил, вердикт.
  - **Вердикты:**
    - `allowed` — Hacker News;
    - `needs_agreement` — Reddit (коммерческое использование только по договору);
    - `rejected` — CFPB (снимает тексты жалоб с 14.08.2026) и Google Trends (официальный API ограничен);
    - `needs_review` — Stack Exchange, Bluesky, Product Hunt.
  - Коннектор отказывается работать с источником без записи (`not_cataloged`) или без `allowed` (`not_allowed`).
- **Коннектор Hacker News** — официальный API, без ключа:
  - список Ask HN;
  - загружаются только новые id;
  - не больше 30 за запуск, не чаще раза в час;
  - таймаут на каждый запрос;
  - HTML → текст;
  - удалённые, `dead` и не-истории пропускаются и не запрашиваются повторно;
  - поле автора не читается;
  - SHA-256 всех ответов.
- **Приватность** — `redactPersonalData` до записи заменяет:
  - email, телефоны;
  - ссылки на профили (HN, X / Twitter, LinkedIn, Facebook, Instagram, TikTok, Telegram, Reddit, GitHub, Bluesky);
  - `@ники`;
  - номера вида SSN;
  - номера карт (с проверкой Луна);
  - IPv4.

  Цитата — до 1 000 символов. Доменное правило не пропускает email и телефоны, CHECK в БД — email.

- **Provenance:**
  - 16-я сущность `SourceSnapshot` — загрузка: источник, время, URL запроса, SHA-256, число новых элементов и сохранённых доказательств. Сырой ответ не хранится.
  - У Evidence — `snapshotId` (БД проверяет, что снимок того же источника) и `externalId` (уникален в источнике).
  - У Source — `catalogKey` (один источник на запись каталога).
- **Сбор `collectEvidence`:**
  1. Стоп-кран — первым шагом.
  2. Каталог.
  3. Источник `active`.
  4. Активная личность интеграции `source:<ключ>`.
  5. Загрузка → очистка → одна транзакция: снимок и Evidence от актора интеграции с `correlationId` `evidence-collect-<id>`.
- **Подключение `ensureConnection`:**
  - от `system`: источник по каталогу и запрос доступа в `/decisions`; текст карточки — условия источника;
  - отказ владельца → источник `retired`;
  - истёкший запрос — новый запрос (`ensureAccessRequest` в пульте).
- **Worker:**
  - с `DATABASE_URL` запускает расписание: раз в 15 минут, без наложения запусков; интервал каталога считается только по реальным запросам к источнику;
  - Docker-образ `apps/worker/Dockerfile` с миграциями; CI собирает и его;
  - без базы работает как раньше.
- **Пульт:**
  - строка «📚 Новых доказательств за сутки: N» в дайджесте;
  - журнал сворачивает события одного запроса в «×N» — 30 доказательств одной загрузки не вытесняют решения владельца.
- **Документы:**
  - спецификация и отчёт, D-019, D-020;
  - инструкция [worker](../deploy/worker.md) для Railway;
  - [runbook запроса на удаление данных](../runbooks/data-deletion-request.md) (CCPA / GDPR);
  - схема БД, архитектура, конституция (§2.5, §2.6, §2.20, §2.21), `CLAUDE.md`, ROADMAP с новым порядком фаз, README пакетов.

## Files created

- `packages/evidence/` — `catalog.ts`, `connector.ts`, `hacker-news.ts`, `privacy.ts`, `html.ts`, `collect.ts`, `scheduler.ts`, `errors.ts`, `index.ts`, `README.md`, `package.json`, `tsconfig.json`
- `packages/domain/src/entities/source-snapshot.ts`, `packages/domain/src/privacy.ts`
- `database/migrations/0005_evidence_engine.sql`
- `apps/worker/src/config.ts`, `apps/worker/Dockerfile`
- `docs/phases/05_evidence_engine.md`, `docs/phases/05_evidence_engine.report.md`, `docs/deploy/worker.md`, `docs/runbooks/data-deletion-request.md`
- Тесты:
  - `tests/unit/evidence/{privacy,html,catalog}.test.ts`;
  - `tests/unit/domain/source-snapshot.test.ts`;
  - `tests/integration/evidence/collect.test.ts`;
  - `tests/support/fake-hacker-news.ts`.

## Files modified

- **Домен:**
  - `primitives.ts` — `source_snapshot`, `SourceSnapshotId`;
  - `entities/source.ts` — `catalogKey`, типы;
  - `entities/evidence.ts` — `snapshotId`, `externalId`, правило контактов, `EvidenceKind`;
  - `index.ts`.
- **События:** `source_snapshot` — запись только с добавлением.
- **Права:** запись снимка — `evidence.write`.
- **База:**
  - `tables.ts` — новые колонки, `sourceSnapshotsTable`;
  - `repositories.ts` — `sources.getByCatalogKey`, `evidence.knownExternalIds`, `sourceSnapshots`;
  - `repository.ts` — `readRows` экспортирован;
  - `index.ts`.
- **Пульт:**
  - `access.ts` — `ensureAccessRequest`, общий конструктор карточки доступа;
  - `digest.ts`, `journal.ts`, `texts.ts` — подпись, `eventRuns`, `runLine`;
  - `index.ts`.
- **Worker:** `main.ts`, `package.json`, `tsconfig.json`, `README.md`.
- **CI:** `.github/workflows/ci.yml` — job `Build worker Docker image`.
- **Корень:** `package.json`, `tsconfig.json`, `pnpm-lock.yaml` — новый пакет.
- **Тесты:**
  - `support/domain.ts` — `INTEGRATION`;
  - миграции — список с `0005`;
  - контракты — 16 сущностей, `source_snapshot.created`;
  - импорт пакетов;
  - пульт — журнал и дайджест;
  - процесс worker — сбор с БД.
- **Документы:** `CLAUDE.md`, `OWNER_DECISIONS.md`, `CURRENT_STATE.md`, `ROADMAP.md`, `SYSTEM_ARCHITECTURE.md`, `CLAUDE_CONSTITUTION.md`, `phases/README.md`, `database/docs/schema.md`, `database/migrations/README.md`, `deploy/database.md`, `runbooks/README.md`, README пакетов domain, database, command-center.

## Database migrations

`0005_evidence_engine`:

- **Тип сущности:** `entity_type` + `source_snapshot`.
- **`sources`:** `catalog_key` — формат и уникальность.
- **Таблица `source_snapshots`:**
  - только добавление, событие обязательно;
  - `(id, source_id)` уникальны;
  - число доказательств ≤ числа элементов;
  - время загрузки ≤ времени записи.
- **`evidence`:**
  - `snapshot_id` — составной FK `(snapshot_id, source_id)`;
  - `external_id` — формат и уникальность в источнике;
  - CHECK `evidence_excerpt_without_email`.

Проверено:

- на пустой БД из Docker-образа worker: 5 миграций, повторный запуск — 0;
- в каждом integration-тесте.

Существующие данные не меняются: только новые колонки, таблица и ограничения, которым строки прошлых фаз удовлетворяют.

## Tests added

- **Unit:**
  - **Очистка:** каждый вид данных; обычный текст с суммами, датами, годами, версиями и номером заказа не меняется; счётчики.
  - **HTML:** посты HN, экранированная разметка, лишние пробелы, неизвестные сущности.
  - **Каталог:**
    - все записи проходят схему;
    - ключи уникальны;
    - вердикты зафиксированы;
    - коннектор работает только с `allowed`;
    - запрос доступа и запись Source валидны.
  - **Домен:** снимок и его правила; Evidence с email или телефоном отклоняется; provenance; формат `catalogKey`.
- **Integration (настоящая PostgreSQL, фейковый Hacker News):**
  - каталог прежде всего: источник без записи или не `allowed` → отказ без единого запроса;
  - подключение → карточка в `/decisions` с условиями; повтор — «ждёт»; до одобрения ни одного запроса;
  - после одобрения:
    - 2 Evidence из 5 элементов (dead, deleted, comment пропущены);
    - контакты и профиль заменены;
    - длинный пост сокращён;
    - ник автора, email, телефон, профиль не найдены нигде в БД, включая события;
    - хеш снимка совпадает с ответами;
    - correlation id;
  - повторный сбор запрашивает только новый id, затем — «нового нет»;
  - стоп-кран останавливает сбор и подключение до запросов;
  - ошибка источника (503) — ничего не записано;
  - элемент, который нельзя сохранить, пропускается с записью в лог без текста; остальные сохраняются;
  - отказ владельца → источник `retired`, сбор пропускается;
  - запрос истёк → новый запрос;
  - БД: email в цитате, повтор элемента, снимок чужого источника, удаление снимка — отклоняются;
  - пульт: загрузка в журнале — одна строка «×3»; строка Evidence в дайджесте;
  - **процесс worker с БД:**
    1. запрашивает доступ, без запросов к источнику до одобрения;
    2. после одобрения собирает очищенный пост;
    3. по SIGTERM выходит с кодом 0;
    4. в логах нет URL базы, телефона и ника.

## Test results

| Проверка            | Результат                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | pass                                                                                              |
| `pnpm lint`         | pass (0 warnings)                                                                                 |
| `pnpm format:check` | pass                                                                                              |
| `pnpm test`         | 49 файлов, 514 тестов — pass (unit 372, integration 142); было 479                                |
| `pnpm build`        | pass                                                                                              |
| Docker worker       | образ собран; миграции на пустой БД — 5, повторно — 0; запуск запрашивает доступ и ждёт одобрения |

## Security implications

- **Доступ к источнику — только после двух проверок:**
  - проверка условий (каталог в коде, изменения — через PR владельца);
  - одобрение владельца (`access_grant`).

  Отключить источник можно сразу: `/access` (⏸ / ⛔) или `/stop`.

- **Интеграция пишет только Evidence и снимки** (права PHASE 04). Источник создаёт `system`. Решений и трат интеграция не делает.
- **Персональные данные** вычищаются до записи и не попадают в события. Автор не запрашивается. Сырые ответы не хранятся.
- **Worker не принимает входящих соединений.** Секрет у него один — `DATABASE_URL` (ссылкой в Railway); логгер его редактирует.

## Cost implications

- Hacker News бесплатен, расходы не записываются.
- Сервис worker в Railway — около $1–3 в месяц. Вместе с ботом и базой — в пределах $20/мес (D-007).

## Known limitations

- **Сайты источников недоступны из облачной среды разработки.** Поэтому:
  - коннектор проверен на фейковом API;
  - условия площадок проверены по документации и вторичным источникам — это записано в каталоге.

  Первая реальная загрузка — после запуска worker в Railway.

- **Имена людей внутри текста не вычищаются** — нужен AI (PHASE 09).
- **У Evidence из HN нет рынка:** аудитория глобальная англоязычная.
- **Пропущенные элементы помнятся до перезапуска worker.** После перезапуска они загружаются ещё раз, не больше лимита.
- **Удаление по запросу человека** — аварийная миграция по runbook. Кнопки нет.
- **Обязательные проверки ruleset** — по-прежнему две старые (`Typecheck, lint, test, build`, `Build bot Docker image`). Новую `Build worker Docker image` владелец может добавить в ruleset.

## Technical debt

- Расписание внутри процесса. Если появятся долгие workflow, нужен Temporal (ADR).

## Architecture deviations

- Нет. Сбор работает в `apps/worker`, как задумано.
- Temporal не подключён: по TECH_STACK он нужен перед первым долгим workflow, а сбор — короткая задача.
- `ensureAccessRequest` передаётся в `@roi-dealer/evidence` как зависимость, чтобы пакет сбора не зависел от Telegram.

## Scope decisions

- **Первый и единственный коннектор — Hacker News:** единственный источник с подтверждённым бесплатным официальным доступом без договора. Остальные остаются в каталоге до проверки условий.
- **Сырые снимки не хранятся** (хранить их — S3 и риск ПД без пользы). Для provenance достаточно хеша и ссылки.
- **Claims** (утверждения из текста) — PHASE 06 и 09.
- **Ручной ввод Evidence** — PHASE 13.

## Business hypothesis enabled by this phase

Система каждый час получает реальные формулировки проблем англоязычной технической аудитории (Ask HN). С PHASE 09 и 06 AI начнёт находить в них боли, а владелец увидит первые сигналы с доказательствами.

## Authoritative data paths verified

```text
Hacker News API → коннектор → redactPersonalData → SourceSnapshot + Evidence (PostgreSQL, события)
→ /journal, дайджест
```

## Ready for next phase

- **Да.** По D-020 следующая — **PHASE 09 AI Runtime**.
- **Действия владельца по PHASE 05:**
  1. влить PR;
  2. создать сервис worker ([инструкция](../deploy/worker.md));
  3. одобрить «Доступ: Hacker News» в `/decisions`;
  4. включить ежедневные копии Postgres.
