# Current State

```text
Current Phase: 13b — Owner Approvals, Kill Switch, Journal and Digest (early step of PHASE 13)
Phase Status: PASS
Completed: 00 — Project Bootstrap (PASS), 01 — Core Domain (PASS, accepted D-015), 02 — PostgreSQL Foundation (PASS, accepted D-016), 03 — Event History (PASS, accepted D-017), 13a — Telegram Owner Bot (PASS, owner-approved early step)
Playbook: v1.1
Updated: 2026-09-25
```

Отчёты: [PHASE 00](phases/00_project_bootstrap.report.md), [13a — Telegram Owner Bot](phases/13a_telegram_owner_bot.report.md), [PHASE 01 — Core Domain](phases/01_core_domain.report.md), [PHASE 02 — PostgreSQL Foundation](phases/02_postgresql_foundation.report.md), [PHASE 03 — Event History](phases/03_event_history.report.md), [13b — Одобрения и стоп-кран](phases/13b_owner_approvals.report.md)

Решения владельца: [`docs/OWNER_DECISIONS.md`](OWNER_DECISIONS.md) · План до рабочего состояния: [`docs/ROADMAP.md`](ROADMAP.md)

## Implemented

- pnpm monorepo (`apps/*`, `packages/*`), воспроизводимая установка (`pnpm install --frozen-lockfile`).
- TypeScript 6.0 strict + project references (`tsc -b`), ESLint 10 (type-aware, `no-console`), Prettier.
- Vitest: 40 test files, 441 tests (329 unit, 112 integration); integration-тесты работают с настоящим PostgreSQL 18.
- Config validation (Zod), structured JSON logging с редактированием секретов, correlation id, health registry, graceful shutdown.
- `GET /health` → `{"status":"ok","service":"api"}`; при заданном `DATABASE_URL` — ещё проверка `database` (недоступна → HTTP 503).
- Docker Compose: PostgreSQL 18 (healthcheck, volume, loopback-only, UTC).
- GitHub Actions CI: install → typecheck → lint → format check → unit tests → build → миграции → integration tests (сервис PostgreSQL 18) → compose validation; сборка Docker-образа бота. Первый запуск на GitHub — success ([run #1](https://github.com/userpr0/roi-dealer/actions/runs/36001981452)).
- Документация: конституция, архитектура, стек, протокол, ADR (ADR-0001…0005 Accepted), решения владельца (D-001…D-017), план кнопок пульта, phases, runbooks, playbook v1.1.
- **PHASE 01 — Core Domain:** `@roi-dealer/domain` — 13 сущностей цикла ROI CORE v0.1 (Source → … → Reward, ApprovalRequest), value objects (UUID, UTC, USD в центах, Actor), state machines и 11 правил (решения только владельца, evidence first, 5 разных гипотез, human gate $20, актив по итогам эксперимента, Reward только за проверенный вклад); `@roi-dealer/schemas` — строгие входные контракты; `uuidv7()` в `@roi-dealer/shared`.
- **PHASE 02 — PostgreSQL Foundation:** пакет `@roi-dealer/database` (postgres.js, [ADR-0005](ADR/0005-postgresql-driver-and-migrations.md)) — пул в UTC, раннер SQL-миграций (SHA-256, блокировка, транзакция на файл), 13 репозиториев с optimistic locking и проверкой прочитанного доменной схемой, транзакции, ошибки без значений; миграция `0001_core_domain` — таблицы 13 сущностей, связи, CHECK / FK для денег, времени и human gates, триггеры защиты истории ([схема](../database/docs/schema.md)); `pnpm db:migrate`; инструкция для облачной БД [`docs/deploy/database.md`](deploy/database.md).
- **PHASE 03 — Event History:** пакет `@roi-dealer/events` (22 типа событий `<entity>.created` / `.updated`, конверт, correlation id, ключи идемпотентности); миграция `0002_event_history` — таблица `events` (append-only, одна версия — одно событие), проверка при `COMMIT` «нет изменения сущности без события», `idempotency_keys`; репозитории пишут событие на каждую запись в той же транзакции (`update(entity, actor)` с блокировкой строки); `database.events.history` / `list` (журнал за период, постранично); `database.transaction(work, { correlationId })`; `database.command({ idempotencyKey })` — ровно один раз, в том числе при одновременных повторах.
- **13b — одобрения, стоп-кран, журнал и дайджест (D-002, D-009, D-010, D-017):** пакет `@roi-dealer/command-center`; в боте — `/decisions` (карточки ✅ / ❌ → вопрос с суммой → **Да**), `/stop [причина]` и `/resume` с подтверждением на 10 минут, `/journal` и `/history` за день / неделю / месяц по Киеву, `/digest` и ежедневный дайджест в 10:00 `Europe/Kyiv` (один раз в день, в том числе после перезапуска). Каждое действие — идемпотентная команда БД (`tg-callback-<id>`) с событием от `owner` (`telegram:<id>`). Новая сущность `SystemControl` и правило `assertAutomationRunning`; миграция `0003_system_control`; `listByStatus` в репозиториях; inline-кнопки и `callback_query` в `@roi-dealer/telegram`. `DATABASE_URL` у бота необязателен; Docker-образ содержит миграции, в Railway их применяет Pre-deploy Command.
- **Фаза 13a (по запросу владельца, [ADR-0003](ADR/0003-early-telegram-owner-bot.md)):** бот-пульт в Telegram — только владелец, `/start` `/status` `/help`, уведомления о запуске / остановке, long polling; пакет `@roi-dealer/telegram`; Docker-образ `apps/bot/Dockerfile` (собирается в CI); инструкция [`docs/deploy/telegram-bot.md`](deploy/telegram-bot.md).
- **По запросу владельца после PHASE 00:** публикация placeholder miniapp на GitHub Pages (https://userpr0.github.io/roi-dealer/) для открытия в Telegram — [ADR-0002](ADR/0002-miniapp-hosting-github-pages.md), workflow `.github/workflows/miniapp-pages.yml`.

## Not Implemented

- Бизнес-логика поверх домена и хранения (сервисы, API-эндпоинты); Customer / Product / Revenue и другие сущности поздних фаз.
- Облачная PostgreSQL — создаёт владелец ([инструкция](deploy/database.md)); staging — после неё и тестового бота (A5).
- RBAC и аудит действий без изменения состояния (PHASE 04), AI runtime и провайдеры (PHASE 09), agents / judges (PHASE 10–11).
- Mini App с данными и проверкой `initData`, кнопки 🔍 / ⏸ по возможностям (PHASE 12), поиск и добавление данных, бюджеты, эксперименты, статистика (PHASE 13 и фазы-источники).
- Автопауза при аномальных тратах (D-014 п.10) — когда появятся траты (PHASE 16); стоп-кран готов её принять.
- Temporal и S3-compatible storage (placeholders в `infra/README.md`).
- Metrics, tracing, alerts; deployment backend-сервисов; production cloud resources.

## Applications

| App            | Состояние                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`     | `GET/HEAD /health` (+ проверка `database`, если задан `DATABASE_URL`), 404 / 405 / 500 обработка, correlation id, access log, graceful shutdown          |
| `apps/worker`  | start → heartbeat (debug log) → SIGTERM / SIGINT → graceful stop, exit 0                                                                                 |
| `apps/miniapp` | React 19 + Vite 8, placeholder-экран; dev / build / preview работают                                                                                     |
| `apps/bot`     | Бот-пульт (13a–13b): `/status`, уведомления; с `DATABASE_URL` — решения, стоп-кран, журнал, история, дайджест; работает в Railway (EU West), пока без БД |

## Packages

| Package                                                                        | Состояние                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@roi-dealer/shared`                                                           | Реализован: `loadConfig`, `createShutdownManager`, `installProcessHandlers`                                                                                  |
| `@roi-dealer/observability`                                                    | Реализован: `createLogger`, `createHealthRegistry`, `resolveCorrelationId`                                                                                   |
| `@roi-dealer/telegram`                                                         | Реализован (13a–13b): клиент Bot API, inline-кнопки, long polling, owner-only router команд и кнопок, notifier                                               |
| `@roi-dealer/command-center`                                                   | Реализован (13b): одобрения, стоп-кран, журнал, история, дайджест, время по Киеву                                                                            |
| `@roi-dealer/domain`                                                           | Реализован (PHASE 01, 13b): 14 сущностей (с `SystemControl`), value objects, lifecycles, правила                                                             |
| `@roi-dealer/schemas`                                                          | Реализован (PHASE 01): строгие входные контракты, `parseInput`                                                                                               |
| `@roi-dealer/database`                                                         | Реализован (PHASE 02–03, 13b): подключение в UTC, миграции, 14 репозиториев с событиями и `listByStatus`, Event History, идемпотентные команды, health check |
| `@roi-dealer/events`                                                           | Реализован (PHASE 03): контракты событий, correlation id, ключи идемпотентности                                                                              |
| `policies`, `agents`, `judges`, `skills`, `ai-runtime`, `economics`, `rewards` | Placeholders: `PACKAGE_NAME` + README с назначением и Phase                                                                                                  |

## Infrastructure

- `infra/docker/compose.yaml`: `postgres` (PostgreSQL 18.6, `postgres:18-alpine`) — `pnpm infra:up` / `infra:down` / `infra:logs`.
- Проверено: healthy, подключение, `timezone = UTC`, `uuidv7()`, сохранение данных после `down`/`up`, порт только на `127.0.0.1`.
- Схема: миграции `database/migrations/0001_core_domain.sql`, `0002_event_history.sql`, `0003_system_control.sql` (`pnpm db:migrate`; в образе бота — `migrate-cli.js`, проверено на пустой БД и повторном запуске); integration-тесты создают на сервере временные БД и удаляют их.
- Temporal, object storage — только placeholders.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 29    | 329   | pass      |
| integration | 11    | 112   | pass      |

Integration-тесты запускают реальные процессы api / worker / bot (SIGTERM, SIGINT, exit codes, некорректная конфигурация), реальный HTTP-сервер, поддельный Telegram Bot API и PostgreSQL 18: миграции, все репозитории, ограничения БД в обход домена, Event History и идемпотентные команды, полный цикл DoD v0.1 с сохранением и полной историей событий; пульт 13b — одобрение, стоп-кран, журнал и дайджест на настоящей БД и в процессе бота через поддельный Bot API с нажатиями кнопок.

## Этап A — настройка владельцем

- ✅ **A2:** `main` — основная ветка; ruleset `Protect main` активен ([файл](deploy/github-ruleset-protect-main.json)): изменения только через pull request, обязательные проверки CI `Typecheck, lint, test, build` и `Build bot Docker image`, запрет force push и удаления. Claude работает в рабочей ветке и открывает PR, вливает владелец.
- ✅ **A3 (GitHub):** Secret Protection и push protection включены. Двухфакторка аккаунтов — на стороне владельца.
- ✅ **A1:** бот-пульт работает в Railway (регион EU West, 1 реплика, лимиты 1 vCPU / 0.5 GB), деплой из `main` после зелёного CI; 2026-09-25 прислал «🟢 ROI Dealer bot запущен». Настройки — [`deploy/telegram-bot.md`](deploy/telegram-bot.md).
- ✅ **A4 (Railway):** лимиты использования заданы владельцем ($15 оповещение, $20 жёсткий лимит).
- ⏳ **A5:** тестовый бот для локальной разработки — [инструкция](deploy/owner-setup.md).
- ✅ **A6:** инструкции на аварии — [`docs/runbooks/`](runbooks/README.md): утечка токена или ключа, сервис не работает, резкий рост расходов.

## Known Issues

- Для miniapp нет автоматического теста рендеринга (проверено вручную: build + Chromium, ошибок в консоли нет).
- Облачная БД ещё не создана: без неё команды пульта отвечают «База данных не подключена». Команду Pre-deploy и её поведение при ошибке в Railway проверим при первом подключении (документация Railway из облачной среды разработки недоступна).
- Подтверждения `/stop` и `/resume` хранятся в памяти бота: после перезапуска бот просит повторить команду.
- Минимальное число элементов в списках id и существование объекта полиморфной ссылки `subject` проверяет домен, а не БД ([схема](../database/docs/schema.md)).
- В Railway бот показывает версию `dev`: переменная `APP_VERSION` не задана, поэтому по сообщению не видно, какой коммит выкачен.
- Живой Telegram API недоступен из облачной среды разработки — бот проверен на поддельном Bot API и в Docker-контейнере.

## Next Allowed Phase

**Next phase only after owner approval** — по порядку playbook PHASE 04 (Identity / RBAC / Security). Действие владельца для Уровня 1: влить PR, создать облачную PostgreSQL и подключить бота ([инструкция](deploy/database.md)).
