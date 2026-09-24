# Current State

```text
Current Phase: 00 — Project Bootstrap
Phase Status: PASS
Additional (owner-approved): 13a — Telegram Owner Bot — PASS
Playbook: v1.1
Updated: 2026-09-24
```

Отчёты: [PHASE 00](phases/00_project_bootstrap.report.md), [13a — Telegram Owner Bot](phases/13a_telegram_owner_bot.report.md)

## Implemented

- pnpm monorepo (`apps/*`, `packages/*`), воспроизводимая установка (`pnpm install --frozen-lockfile`).
- TypeScript 6.0 strict + project references (`tsc -b`), ESLint 10 (type-aware, `no-console`), Prettier.
- Vitest: 16 test files, 166 tests (142 unit, 24 integration).
- Config validation (Zod), structured JSON logging с редактированием секретов, correlation id, health registry, graceful shutdown.
- `GET /health` → `{"status":"ok","service":"api"}`.
- Docker Compose: PostgreSQL 18 (healthcheck, volume, loopback-only, UTC).
- GitHub Actions CI: install → typecheck → lint → format check → unit tests → build → integration tests → compose validation. Первый запуск на GitHub — success ([run #1](https://github.com/userpr0/roi-dealer/actions/runs/36001981452)).
- Документация: конституция, архитектура, стек, протокол, ADR (процесс, шаблон, ADR-0001 Proposed), phases, playbook v1.1.
- **Фаза 13a (по запросу владельца, [ADR-0003](ADR/0003-early-telegram-owner-bot.md)):** бот-пульт в Telegram — только владелец, `/start` `/status` `/help`, уведомления о запуске / остановке, long polling; пакет `@roi-dealer/telegram`; Docker-образ `apps/bot/Dockerfile` (собирается в CI); инструкция [`docs/deploy/telegram-bot.md`](deploy/telegram-bot.md).
- **По запросу владельца после PHASE 00:** публикация placeholder miniapp на GitHub Pages (https://userpr0.github.io/roi-dealer/) для открытия в Telegram — [ADR-0002](ADR/0002-miniapp-hosting-github-pages.md), workflow `.github/workflows/miniapp-pages.yml`.

## Not Implemented

- Любая бизнес-логика и доменные сущности (PHASE 01+).
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

| Package                                                                                                       | Состояние                                                                   |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@roi-dealer/shared`                                                                                          | Реализован: `loadConfig`, `createShutdownManager`, `installProcessHandlers` |
| `@roi-dealer/observability`                                                                                   | Реализован: `createLogger`, `createHealthRegistry`, `resolveCorrelationId`  |
| `@roi-dealer/telegram`                                                                                        | Реализован (13a): клиент Bot API, long polling, owner-only router, notifier |
| `domain`, `schemas`, `events`, `policies`, `agents`, `judges`, `skills`, `ai-runtime`, `economics`, `rewards` | Placeholders: `PACKAGE_NAME` + README с назначением и Phase                 |

## Infrastructure

- `infra/docker/compose.yaml`: `postgres` (PostgreSQL 18.6, `postgres:18-alpine`) — `pnpm infra:up` / `infra:down` / `infra:logs`.
- Проверено: healthy, подключение, `timezone = UTC`, `uuidv7()`, сохранение данных после `down`/`up`, порт только на `127.0.0.1`.
- Temporal, object storage — только placeholders.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 12    | 142   | pass      |
| integration | 4     | 24    | pass      |

Integration-тесты запускают реальные процессы api / worker / bot (SIGTERM, SIGINT, exit codes, некорректная конфигурация), реальный HTTP-сервер и поддельный Telegram Bot API.

## Known Issues

- Для miniapp нет автоматического теста рендеринга (проверено вручную: build + Chromium, ошибок в консоли нет).
- ADR-0001 (инструменты и версии PHASE 00) в статусе **Proposed** — ожидает решения владельца.
- Бот ещё не развёрнут в облаке: нужен аккаунт хостинга владельца ([инструкция](deploy/telegram-bot.md)).
- Живой Telegram API недоступен из облачной среды разработки — бот проверен на поддельном Bot API и в Docker-контейнере.

## Next Allowed Phase

**01 only after owner approval.**
