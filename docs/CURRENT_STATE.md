# Current State

```text
Current Phase: 01 — Core Domain
Phase Status: PASS
Completed: 00 — Project Bootstrap (PASS), 13a — Telegram Owner Bot (PASS, owner-approved early step)
Playbook: v1.1
Updated: 2026-09-25
```

Отчёты: [PHASE 00](phases/00_project_bootstrap.report.md), [13a — Telegram Owner Bot](phases/13a_telegram_owner_bot.report.md), [PHASE 01 — Core Domain](phases/01_core_domain.report.md)

Решения владельца: [`docs/OWNER_DECISIONS.md`](OWNER_DECISIONS.md) · План до рабочего состояния: [`docs/ROADMAP.md`](ROADMAP.md)

## Implemented

- pnpm monorepo (`apps/*`, `packages/*`), воспроизводимая установка (`pnpm install --frozen-lockfile`).
- TypeScript 6.0 strict + project references (`tsc -b`), ESLint 10 (type-aware, `no-console`), Prettier.
- Vitest: 25 test files, 262 tests (238 unit, 24 integration).
- Config validation (Zod), structured JSON logging с редактированием секретов, correlation id, health registry, graceful shutdown.
- `GET /health` → `{"status":"ok","service":"api"}`.
- Docker Compose: PostgreSQL 18 (healthcheck, volume, loopback-only, UTC).
- GitHub Actions CI: install → typecheck → lint → format check → unit tests → build → integration tests → compose validation. Первый запуск на GitHub — success ([run #1](https://github.com/userpr0/roi-dealer/actions/runs/36001981452)).
- Документация: конституция, архитектура, стек, протокол, ADR (процесс, шаблон, ADR-0001…0003 Accepted), решения владельца (D-001…D-011), план кнопок пульта, phases, playbook v1.1.
- **PHASE 01 — Core Domain:** `@roi-dealer/domain` — 13 сущностей цикла ROI CORE v0.1 (Source → … → Reward, ApprovalRequest), value objects (UUID, UTC, USD в центах, Actor), state machines и 11 правил (решения только владельца, evidence first, 5 разных гипотез, human gate $20, актив по итогам эксперимента, Reward только за проверенный вклад); `@roi-dealer/schemas` — строгие входные контракты; `uuidv7()` в `@roi-dealer/shared`.
- **Фаза 13a (по запросу владельца, [ADR-0003](ADR/0003-early-telegram-owner-bot.md)):** бот-пульт в Telegram — только владелец, `/start` `/status` `/help`, уведомления о запуске / остановке, long polling; пакет `@roi-dealer/telegram`; Docker-образ `apps/bot/Dockerfile` (собирается в CI); инструкция [`docs/deploy/telegram-bot.md`](deploy/telegram-bot.md).
- **По запросу владельца после PHASE 00:** публикация placeholder miniapp на GitHub Pages (https://userpr0.github.io/roi-dealer/) для открытия в Telegram — [ADR-0002](ADR/0002-miniapp-hosting-github-pages.md), workflow `.github/workflows/miniapp-pages.yml`.

## Not Implemented

- Хранение сущностей и бизнес-логика поверх домена (PHASE 02+); Customer / Product / Revenue и другие сущности поздних фаз.
- Схема БД, миграции, драйвер PostgreSQL (PHASE 02).
- Event History (PHASE 03), RBAC (PHASE 04), AI runtime и провайдеры (PHASE 09), agents / judges (PHASE 10–11).
- Mini App с данными и проверкой `initData`, команды с изменением состояния, approvals в Telegram (PHASE 13).
- Temporal и S3-compatible storage (placeholders в `infra/README.md`).
- Metrics, tracing, alerts; deployment backend-сервисов; production cloud resources.

## Applications

| App            | Состояние                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`     | `GET/HEAD /health`, 404 / 405 / 500 обработка, correlation id, access log, graceful shutdown                                         |
| `apps/worker`  | start → heartbeat (debug log) → SIGTERM / SIGINT → graceful stop, exit 0                                                             |
| `apps/miniapp` | React 19 + Vite 8, placeholder-экран; dev / build / preview работают                                                                 |
| `apps/bot`     | Бот-пульт владельца (13a): `/start` `/status` `/help`, уведомления, long polling, Docker-образ; облачный деплой — действие владельца |

## Packages

| Package                                                                                  | Состояние                                                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@roi-dealer/shared`                                                                     | Реализован: `loadConfig`, `createShutdownManager`, `installProcessHandlers` |
| `@roi-dealer/observability`                                                              | Реализован: `createLogger`, `createHealthRegistry`, `resolveCorrelationId`  |
| `@roi-dealer/telegram`                                                                   | Реализован (13a): клиент Bot API, long polling, owner-only router, notifier |
| `@roi-dealer/domain`                                                                     | Реализован (PHASE 01): сущности, value objects, lifecycles, правила         |
| `@roi-dealer/schemas`                                                                    | Реализован (PHASE 01): строгие входные контракты, `parseInput`              |
| `events`, `policies`, `agents`, `judges`, `skills`, `ai-runtime`, `economics`, `rewards` | Placeholders: `PACKAGE_NAME` + README с назначением и Phase                 |

## Infrastructure

- `infra/docker/compose.yaml`: `postgres` (PostgreSQL 18.6, `postgres:18-alpine`) — `pnpm infra:up` / `infra:down` / `infra:logs`.
- Проверено: healthy, подключение, `timezone = UTC`, `uuidv7()`, сохранение данных после `down`/`up`, порт только на `127.0.0.1`.
- Temporal, object storage — только placeholders.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 21    | 238   | pass      |
| integration | 4     | 24    | pass      |

Integration-тесты запускают реальные процессы api / worker / bot (SIGTERM, SIGINT, exit codes, некорректная конфигурация), реальный HTTP-сервер и поддельный Telegram Bot API.

## Этап A — настройка владельцем

- ✅ **A2:** `main` — основная ветка; ruleset `Protect main` активен ([файл](deploy/github-ruleset-protect-main.json)): изменения только через pull request, обязательные проверки CI `Typecheck, lint, test, build` и `Build bot Docker image`, запрет force push и удаления. Claude работает в рабочей ветке и открывает PR, вливает владелец.
- ✅ **A3 (GitHub):** Secret Protection и push protection включены. Двухфакторка аккаунтов — на стороне владельца.
- ⏳ **A1, A4, A5:** бот в Railway, лимит расходов $20, тестовый бот — [инструкция](deploy/owner-setup.md).
- ⏳ **A6:** инструкции на аварии — Claude, по команде владельца.

## Known Issues

- Для miniapp нет автоматического теста рендеринга (проверено вручную: build + Chromium, ошибок в консоли нет).
- Сущности пока живут только в памяти: хранение в PostgreSQL — PHASE 02.
- Бот ещё не развёрнут в облаке: нужен аккаунт хостинга владельца ([инструкция](deploy/telegram-bot.md)).
- Живой Telegram API недоступен из облачной среды разработки — бот проверен на поддельном Bot API и в Docker-контейнере.

## Next Allowed Phase

**02 (PostgreSQL Foundation) only after owner approval.** Затем 03 → одобрения и стоп-кран в пульте (D-002).
