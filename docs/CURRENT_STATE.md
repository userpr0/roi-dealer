# Current State

```text
Current Phase: 06 — Signals & Pain
Phase Status: PASS
Completed: 00 — Project Bootstrap (PASS), 01 — Core Domain (PASS, accepted D-015), 02 — PostgreSQL Foundation (PASS, accepted D-016), 03 — Event History (PASS, accepted D-017), 13a — Telegram Owner Bot (PASS, owner-approved early step), 13b — Owner Approvals and Kill Switch (PASS, accepted D-018), 04 — Identity / RBAC / Security (PASS, accepted D-019), 05 — Evidence Engine (PASS, PR awaiting merge), 09 — AI Runtime (PASS, PR awaiting merge)
Level: 1 reached (2026-10-18: bot + cloud PostgreSQL in Railway)
Approval mode: D-020 — all phases up to full Level 2 approved; order 05 → 09 → 06 → 07 → 08 → 10 → 11 → 12 → 14 → 15 → 16 → 13 → 17; D-021 — three AI providers, daily AI budget
Playbook: v1.1
Updated: 2026-10-19
```

Отчёты: [PHASE 00](phases/00_project_bootstrap.report.md), [13a — Telegram Owner Bot](phases/13a_telegram_owner_bot.report.md), [PHASE 01 — Core Domain](phases/01_core_domain.report.md), [PHASE 02 — PostgreSQL Foundation](phases/02_postgresql_foundation.report.md), [PHASE 03 — Event History](phases/03_event_history.report.md), [13b — Одобрения и стоп-кран](phases/13b_owner_approvals.report.md), [PHASE 04 — Identity / RBAC / Security](phases/04_identity_access.report.md), [PHASE 05 — Evidence Engine](phases/05_evidence_engine.report.md), [PHASE 09 — AI Runtime](phases/09_ai_runtime.report.md), [PHASE 06 — Signals & Pain](phases/06_signals_pain.report.md)

Решения владельца: [`docs/OWNER_DECISIONS.md`](OWNER_DECISIONS.md) · План до рабочего состояния: [`docs/ROADMAP.md`](ROADMAP.md)

## Implemented

- pnpm monorepo (`apps/*`, `packages/*`), воспроизводимая установка (`pnpm install --frozen-lockfile`).
- TypeScript 6.0 strict + project references (`tsc -b`), ESLint 10 (type-aware, `no-console`), Prettier.
- Vitest: 53 test files, 597 tests (413 unit, 184 integration); integration-тесты работают с настоящим PostgreSQL 18.
- Config validation (Zod), structured JSON logging с редактированием секретов, correlation id, health registry, graceful shutdown.
- `GET /health` → `{"status":"ok","service":"api"}`; при заданном `DATABASE_URL` — ещё проверка `database` (недоступна → HTTP 503).
- Docker Compose: PostgreSQL 18 (healthcheck, volume, loopback-only, UTC).
- GitHub Actions CI: install → typecheck → lint → format check → unit tests → build → миграции → integration tests (сервис PostgreSQL 18) → compose validation; сборка Docker-образа бота. Первый запуск на GitHub — success ([run #1](https://github.com/userpr0/roi-dealer/actions/runs/36001981452)).
- Документация: конституция, архитектура, стек, протокол, ADR (ADR-0001…0006 Accepted), решения владельца (D-001…D-021), план кнопок пульта, phases, runbooks, playbook v1.1.
- **PHASE 01 — Core Domain:** `@roi-dealer/domain` — 13 сущностей цикла ROI CORE v0.1 (Source → … → Reward, ApprovalRequest), value objects (UUID, UTC, USD в центах, Actor), state machines и 11 правил (решения только владельца, evidence first, 5 разных гипотез, human gate $20, актив по итогам эксперимента, Reward только за проверенный вклад); `@roi-dealer/schemas` — строгие входные контракты; `uuidv7()` в `@roi-dealer/shared`.
- **PHASE 02 — PostgreSQL Foundation:** пакет `@roi-dealer/database` (postgres.js, [ADR-0005](ADR/0005-postgresql-driver-and-migrations.md)) — пул в UTC, раннер SQL-миграций (SHA-256, блокировка, транзакция на файл), 13 репозиториев с optimistic locking и проверкой прочитанного доменной схемой, транзакции, ошибки без значений; миграция `0001_core_domain` — таблицы 13 сущностей, связи, CHECK / FK для денег, времени и human gates, триггеры защиты истории ([схема](../database/docs/schema.md)); `pnpm db:migrate`; инструкция для облачной БД [`docs/deploy/database.md`](deploy/database.md).
- **PHASE 03 — Event History:** пакет `@roi-dealer/events` (22 типа событий `<entity>.created` / `.updated`, конверт, correlation id, ключи идемпотентности); миграция `0002_event_history` — таблица `events` (append-only, одна версия — одно событие), проверка при `COMMIT` «нет изменения сущности без события», `idempotency_keys`; репозитории пишут событие на каждую запись в той же транзакции (`update(entity, actor)` с блокировкой строки); `database.events.history` / `list` (журнал за период, постранично); `database.transaction(work, { correlationId })`; `database.command({ idempotencyKey })` — ровно один раз, в том числе при одновременных повторах.
- **13b — одобрения, стоп-кран, журнал и дайджест (D-002, D-009, D-010, D-017):** пакет `@roi-dealer/command-center`; в боте — `/decisions` (карточки ✅ / ❌ → вопрос с суммой → **Да**), `/stop [причина]` и `/resume` с подтверждением на 10 минут, `/journal` и `/history` за день / неделю / месяц по Киеву, `/digest` и ежедневный дайджест в 10:00 `Europe/Kyiv` (один раз в день, в том числе после перезапуска). Каждое действие — идемпотентная команда БД (`tg-callback-<id>`) с событием от `owner` (`telegram:<id>`). Новая сущность `SystemControl` и правило `assertAutomationRunning`; миграция `0003_system_control`; `listByStatus` в репозиториях; inline-кнопки и `callback_query` в `@roi-dealer/telegram`. `DATABASE_URL` у бота необязателен; Docker-образ содержит миграции, в Railway их применяет Pre-deploy Command.
- **PHASE 04 — Identity / RBAC / Security (D-018):**
  - `@roi-dealer/policies` — роли (тип актора) и права с минимальными полномочиями; агенту недоступны решения, одобрения, стоп-кран и доступы; интеграции — только Evidence и расходы.
  - 15-я сущность `Principal` — личность агента, интеграции или участника: `pending` → `active` ⇄ `suspended` → `revoked`; выдаёт, приостанавливает и отзывает только владелец.
  - Каждая запись репозитория проверяет право роли и активную личность; триггер БД не пропускает событие без активной личности.
  - Доступ новой интеграции или агента — `requestAccess` → карточка `access_grant` в `/decisions`.
  - `/access` — приостановить, вернуть, отозвать с подтверждением.
  - Журнал доступа `access_log`: просмотры пульта, отказы записи (даже при откате), попытки посторонних (раз в 10 минут на отправителя, без текста); строка об отказах в дайджесте.
  - Миграция `0004_identity_access`.
- **PHASE 05 — Evidence Engine (D-019):**
  - **Пакет `@roi-dealer/evidence`:**
    - каталог источников с проверенными условиями: 7 записей, `allowed` только у Hacker News; Reddit требует договора, CFPB снимает тексты жалоб, остальные ждут проверки;
    - коннектор Hacker News (Ask HN, официальный API);
    - очистка персональных данных: email, телефоны, профили, ники, SSN, карты, IP; автор не читается;
    - сбор: стоп-кран → каталог → доступ интеграции → загрузка → очистка → одна транзакция;
    - подключение источника с запросом доступа в `/decisions`;
    - расписание в worker.
  - **Домен:** 16-я сущность `SourceSnapshot` (загрузка: время, запрос, SHA-256, без сырого ответа); у `Source` — `catalogKey`; у `Evidence` — `snapshotId`, `externalId` и правило «нет email и телефонов».
  - **Миграция `0005_evidence_engine`:** `source_snapshots`, `catalog_key`, составной FK «снимок того же источника», уникальность элемента в источнике, CHECK без email.
  - **Worker:** сбор по расписанию (`DATABASE_URL`, без Temporal), Docker-образ `apps/worker/Dockerfile` с миграциями; CI собирает оба образа.
  - **Пульт:** `ensureAccessRequest` (повтор истёкшего запроса); строка Evidence в дайджесте; журнал сворачивает пачку событий одного запроса в «×N».
  - **Документы:** [инструкция worker](deploy/worker.md), [runbook запроса на удаление данных](runbooks/data-deletion-request.md).
- **PHASE 09 — AI Runtime (D-020, D-021, [ADR-0006](ADR/0006-ai-providers-and-runtime.md)):**
  - **`runTask`** в `@roi-dealer/ai-runtime` — единственная точка вызова AI. Порядок проверок: вход по схеме → стоп-кран → модели с проходным отчётом evals → бюджет → вызов → ответ по схеме → журнал. При сбое — модель другого провайдера.
  - **Провайдеры:** Claude, GPT и Gemini через официальные SDK, без автоповторов SDK.
  - **Порядок моделей задают evals:** массовая работа — самая дешёвая из прошедших эталон, суждения — самая точная.
  - **Бюджет:**
    - $50 в месяц;
    - квота дня — остаток месяца на оставшиеся дни, не больше $20;
    - у каждого процесса своя доля дня, у evals — 20 %.
  - **Evals:** эталонный набор от 20 примеров; отчёт — `KnowledgeAsset`; модель без проходного отчёта не используется.
  - **Миграция `0006_ai_runtime`:** журнал `ai_calls`; ежедневная `CostEntry` категории `ai`.
  - **Первая задача `redact-names`:** AI находит имена людей, код заменяет их на `[name]` в новых Evidence.
  - **Worker:** ключи провайдеров, обслуживание раз в час.
  - **Пульт:** строка AI в `/status` и в дайджесте.
- **PHASE 06 — Signals & Pain (D-020):**
  - **Агент `pain-analyst`** (`@roi-dealer/signals`) разбирает каждое новое Evidence один раз. Доступ выдаёт владелец в `/decisions`; стоп-кран — первым шагом.
  - **AI-задача `extract-signal`** находит боль, формулирует её одним утверждением и приводит дословную цитату. Код проверяет, что цитата действительно есть в тексте.
  - **Группировка:** сначала словесное сходство (бесплатно), затем AI-задача `match-pain` по ≤ 10 ближайшим. Похожие сигналы собираются в одного кандидата `Pain`; частота и тяжесть растут; два источника → `validated`.
  - **Домен:** `addSignalToPain`.
  - **Миграция `0007_signals_pain`:** журнал `signal_extractions`.
  - **Пульт:** `/pains`, строка в дайджесте.
  - **Бюджет:** доли дня 15 % + 5 %.
- **Фаза 13a (по запросу владельца, [ADR-0003](ADR/0003-early-telegram-owner-bot.md)):** бот-пульт в Telegram — только владелец, `/start` `/status` `/help`, уведомления о запуске / остановке, long polling; пакет `@roi-dealer/telegram`; Docker-образ `apps/bot/Dockerfile` (собирается в CI); инструкция [`docs/deploy/telegram-bot.md`](deploy/telegram-bot.md).
- **По запросу владельца после PHASE 00:** публикация placeholder miniapp на GitHub Pages (https://userpr0.github.io/roi-dealer/) для открытия в Telegram — [ADR-0002](ADR/0002-miniapp-hosting-github-pages.md), workflow `.github/workflows/miniapp-pages.yml`.

## Not Implemented

- Бизнес-логика поверх домена и хранения (сервисы, API-эндпоинты); Customer / Product / Revenue и другие сущности поздних фаз.
- Сервис worker в Railway — создаёт владелец ([инструкция](deploy/worker.md)); staging — после тестового бота (A5).
- Другие источники данных — после проверки их условий (каталог); пока источник один, боли остаются кандидатами (для подтверждения нужны 2 источника).
- Оценка возможностей — PHASE 07; ручное слияние и отклонение болей — PHASE 13.
- Ключи AI в Railway — вписывает владелец ([инструкция](deploy/worker.md#ai-ключи-phase-09)); до этого AI выключен, Evidence чистится правилами.
- Подключение команды к боту (роль `member` в Telegram) — когда появится команда (D-004); учётные данные сервисных аккаунтов для внешнего API — с первым внешним клиентом; настраиваемая политика одобрений — PHASE 16.
- Agents / judges (PHASE 10–11); сильные модели OpenAI и Google — с первой `strong`-задачей.
- Mini App с данными и проверкой `initData`, кнопки 🔍 / ⏸ по возможностям (PHASE 12), поиск и добавление данных, бюджеты, эксперименты, статистика (PHASE 13 и фазы-источники).
- Автопауза при аномальных тратах (D-014 п.10) — когда появятся траты (PHASE 16); стоп-кран готов её принять.
- Temporal и S3-compatible storage (placeholders в `infra/README.md`).
- Metrics, tracing, alerts; deployment backend-сервисов; production cloud resources.

## Applications

| App            | Состояние                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`     | `GET/HEAD /health` (+ проверка `database`, если задан `DATABASE_URL`), 404 / 405 / 500 обработка, correlation id, access log, graceful shutdown                                                                                                                    |
| `apps/worker`  | heartbeat, graceful stop; с `DATABASE_URL` — сбор Evidence по расписанию (PHASE 05); с ключами AI — проверка моделей, evals, вычистка имён, расходы AI (PHASE 09), агент болей (PHASE 06); Docker-образ с миграциями; в облаке — после создания сервиса владельцем |
| `apps/miniapp` | React 19 + Vite 8, placeholder-экран; dev / build / preview работают                                                                                                                                                                                               |
| `apps/bot`     | Бот-пульт (13a–13b, PHASE 04): `/status`, уведомления; с `DATABASE_URL` — решения, стоп-кран, журнал, история, дайджест, `/access`, журнал доступа; работает в Railway (EU West) с облачной PostgreSQL                                                             |

## Packages

| Package                                              | Состояние                                                                                                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@roi-dealer/shared`                                 | Реализован: `loadConfig`, `createShutdownManager`, `installProcessHandlers`                                                                                                                                    |
| `@roi-dealer/observability`                          | Реализован: `createLogger`, `createHealthRegistry`, `resolveCorrelationId`                                                                                                                                     |
| `@roi-dealer/telegram`                               | Реализован (13a–13b, PHASE 04): клиент Bot API, inline-кнопки, long polling, owner-only router команд и кнопок с передачей отказов, notifier                                                                   |
| `@roi-dealer/command-center`                         | Реализован (13b, PHASE 04): одобрения, стоп-кран, журнал, история, дайджест, время по Киеву; доступы и журнал доступа                                                                                          |
| `@roi-dealer/policies`                               | Реализован (PHASE 04): роли и права, проверка доступа                                                                                                                                                          |
| `@roi-dealer/domain`                                 | Реализован (PHASE 01, 13b, PHASE 04–05, 09): 16 сущностей (с `SystemControl`, `Principal`, `SourceSnapshot`), value objects, lifecycles, правила, приватность Evidence, бюджет AI на день                      |
| `@roi-dealer/signals`                                | Реализован (PHASE 06): агент болей и сигналов, задачи `extract-signal` и `match-pain`, проверка цитат, группировка, расписание                                                                                 |
| `@roi-dealer/ai-runtime`                             | Реализован (PHASE 09): `runTask`, адаптеры Claude / GPT / Gemini, порядок по evals, бюджет, evals, задача `redact-names`, обслуживание                                                                         |
| `@roi-dealer/evidence`                               | Реализован (PHASE 05): каталог источников, коннектор Hacker News, очистка персональных данных, сбор с provenance, расписание                                                                                   |
| `@roi-dealer/schemas`                                | Реализован (PHASE 01): строгие входные контракты, `parseInput`                                                                                                                                                 |
| `@roi-dealer/database`                               | Реализован (PHASE 02–05, 09, 13b): подключение в UTC, миграции, 16 репозиториев с событиями, проверкой прав и `listByStatus`, Event History, идемпотентные команды, журналы доступа и вызовов AI, health check |
| `@roi-dealer/events`                                 | Реализован (PHASE 03): контракты событий, correlation id, ключи идемпотентности                                                                                                                                |
| `agents`, `judges`, `skills`, `economics`, `rewards` | Placeholders: `PACKAGE_NAME` + README с назначением и Phase                                                                                                                                                    |

## Infrastructure

- `infra/docker/compose.yaml`: `postgres` (PostgreSQL 18.6, `postgres:18-alpine`) — `pnpm infra:up` / `infra:down` / `infra:logs`.
- Проверено: healthy, подключение, `timezone = UTC`, `uuidv7()`, сохранение данных после `down`/`up`, порт только на `127.0.0.1`.
- Схема: миграции `database/migrations/0001_core_domain.sql`, `0002_event_history.sql`, `0003_system_control.sql`, `0004_identity_access.sql`, `0005_evidence_engine.sql`, `0006_ai_runtime.sql`, `0007_signals_pain.sql` (`pnpm db:migrate`; в образах бота и worker — `migrate-cli.js`, проверено на пустой БД и повторном запуске; в облаке применены 0001–0004 при Уровне 1); integration-тесты создают на сервере временные БД и удаляют их.
- Temporal, object storage — только placeholders.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 37    | 413   | pass      |
| integration | 16    | 184   | pass      |

Integration-тесты запускают реальные процессы api / worker / bot (SIGTERM, SIGINT, exit codes, некорректная конфигурация), реальный HTTP-сервер, поддельный Telegram Bot API и PostgreSQL 18: миграции, все репозитории, ограничения БД в обход домена, Event History и идемпотентные команды, полный цикл DoD v0.1 с сохранением и полной историей событий; пульт 13b — одобрение, стоп-кран, журнал и дайджест на настоящей БД и в процессе бота через поддельный Bot API с нажатиями кнопок; PHASE 04 — права на каждой записи, отказы в журнале доступа (в том числе после отката), защита БД от записи без личности, выдача и отзыв доступа из пульта, попытки посторонних; PHASE 05 — сбор с фейковым Hacker News: каталог, доступ, стоп-кран, очистка персональных данных, дедупликация, provenance, ограничения БД, процесс worker; PHASE 09 — фейковые API Anthropic, OpenAI и Gemini: evals и их отчёты, порядок по evals, классы сбоев и переход на другого провайдера, бюджет дня и долей, стоп-кран, вычистка имён в Evidence, процесс worker с тремя провайдерами; PHASE 06 — агент болей на настоящей БД и фейковом AI: доступ, evals, сигналы с проверкой цитат, группировка и подтверждение болей, разбор каждого Evidence один раз, остановки, `/pains`, процесс worker.

## Этап A — настройка владельцем

- ✅ **A2:** `main` — основная ветка; ruleset `Protect main` активен ([файл](deploy/github-ruleset-protect-main.json)): изменения только через pull request, обязательные проверки CI `Typecheck, lint, test, build` и `Build bot Docker image`, запрет force push и удаления. Claude работает в рабочей ветке и открывает PR, вливает владелец.
- ✅ **A3 (GitHub):** Secret Protection и push protection включены. Двухфакторка аккаунтов — на стороне владельца.
- ✅ **A1:** бот-пульт работает в Railway (регион EU West, 1 реплика, лимиты 1 vCPU / 0.5 GB), деплой из `main` после зелёного CI; 2026-09-25 прислал «🟢 ROI Dealer bot запущен». Настройки — [`deploy/telegram-bot.md`](deploy/telegram-bot.md).
- ✅ **A4 (Railway):** лимиты использования заданы владельцем ($15 оповещение, $20 жёсткий лимит).
- ⏳ **A5:** тестовый бот для локальной разработки — [инструкция](deploy/owner-setup.md).
- ✅ **A6:** инструкции на аварии — [`docs/runbooks/`](runbooks/README.md): утечка токена или ключа, сервис не работает, резкий рост расходов.

## Known Issues

- Для miniapp нет автоматического теста рендеринга (проверено вручную: build + Chromium, ошибок в консоли нет).
- Сайты источников недоступны из облачной среды разработки: коннектор проверен на фейковом Hacker News, условия площадок — по документации и вторичным источникам (записано в каталоге). Первая реальная загрузка — после запуска worker в Railway.
- Имена людей внутри текста вычищает AI (PHASE 09) — только когда в worker есть ключи; без них остаются правила.
- API AI-провайдеров недоступны из облачной среды разработки: адаптеры проверены на фейковых серверах; цены OpenAI — по сторонним сводкам ([ADR-0006](ADR/0006-ai-providers-and-runtime.md)).
- Подтверждения `/stop` и `/resume` хранятся в памяти бота: после перезапуска бот просит повторить команду.
- Минимальное число элементов в списках id и существование объекта полиморфной ссылки `subject` проверяет домен, а не БД ([схема](../database/docs/schema.md)).
- В Railway бот показывает версию `dev`: переменная `APP_VERSION` не задана, поэтому по сообщению не видно, какой коммит выкачен.
- Живой Telegram API недоступен из облачной среды разработки — бот проверен на поддельном Bot API и в Docker-контейнере.

## Next Allowed Phase

**PHASE 07 — Opportunity Engine** (одобрена D-020; порядок 05 → 09 → 06 → 07 → 08 …), затем без остановок по плану [`ROADMAP.md`](ROADMAP.md).

Действия владельца для PHASE 05, 09 и 06 ([инструкция](deploy/worker.md)):

1. Влить PR.
2. Создать сервис worker.
3. Одобрить «Доступ: Hacker News» в `/decisions`.
4. Включить копии БД.
5. Вписать ключи Claude, GPT и Gemini в Variables worker; лимиты в кабинетах — в сумме ≤ $50/мес.
6. Одобрить «Доступ: Агент болей и сигналов» в `/decisions`.
