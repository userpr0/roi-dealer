# Current State

```text
Current Phase: 00 — Project Bootstrap
Phase Status: PASS
Playbook: v1.1
Updated: 2026-09-24
```

Отчёт: [`docs/phases/00_project_bootstrap.report.md`](phases/00_project_bootstrap.report.md)

## Implemented

- pnpm monorepo (`apps/*`, `packages/*`), воспроизводимая установка (`pnpm install --frozen-lockfile`).
- TypeScript 6.0 strict + project references (`tsc -b`), ESLint 10 (type-aware, `no-console`), Prettier.
- Vitest: 12 test files, 106 tests (90 unit, 16 integration).
- Config validation (Zod), structured JSON logging с редактированием секретов, correlation id, health registry, graceful shutdown.
- `GET /health` → `{"status":"ok","service":"api"}`.
- Docker Compose: PostgreSQL 18 (healthcheck, volume, loopback-only, UTC).
- GitHub Actions CI: install → typecheck → lint → format check → unit tests → build → integration tests → compose validation.
- Документация: конституция, архитектура, стек, протокол, ADR (процесс, шаблон, ADR-0001 Proposed), phases, playbook v1.1.

## Not Implemented

- Любая бизнес-логика и доменные сущности (PHASE 01+).
- Схема БД, миграции, драйвер PostgreSQL (PHASE 02).
- Event History (PHASE 03), RBAC (PHASE 04), AI runtime и провайдеры (PHASE 09), agents / judges (PHASE 10–11).
- Telegram-интеграция miniapp / bot (PHASE 13).
- Temporal и S3-compatible storage (placeholders в `infra/README.md`).
- Metrics, tracing, alerts; deployment; production cloud resources.

## Applications

| App            | Состояние                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`     | `GET/HEAD /health`, 404 / 405 / 500 обработка, correlation id, access log, graceful shutdown |
| `apps/worker`  | start → heartbeat (debug log) → SIGTERM / SIGINT → graceful stop, exit 0                     |
| `apps/miniapp` | React 19 + Vite 8, placeholder-экран; dev / build / preview работают                         |
| `apps/bot`     | Skeleton: одна structured-запись, exit 0; токен не читается                                  |

## Packages

| Package                                                                                                       | Состояние                                                                   |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@roi-dealer/shared`                                                                                          | Реализован: `loadConfig`, `createShutdownManager`, `installProcessHandlers` |
| `@roi-dealer/observability`                                                                                   | Реализован: `createLogger`, `createHealthRegistry`, `resolveCorrelationId`  |
| `domain`, `schemas`, `events`, `policies`, `agents`, `judges`, `skills`, `ai-runtime`, `economics`, `rewards` | Placeholders: `PACKAGE_NAME` + README с назначением и Phase                 |

## Infrastructure

- `infra/docker/compose.yaml`: `postgres` (PostgreSQL 18.6, `postgres:18-alpine`) — `pnpm infra:up` / `infra:down` / `infra:logs`.
- Проверено: healthy, подключение, `timezone = UTC`, `uuidv7()`, сохранение данных после `down`/`up`, порт только на `127.0.0.1`.
- Temporal, object storage — только placeholders.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 8     | 90    | pass      |
| integration | 4     | 16    | pass      |

Integration-тесты запускают реальные процессы api / worker / bot (SIGTERM, SIGINT, exit codes, некорректная конфигурация) и реальный HTTP-сервер.

## Known Issues

- CI workflow создан; прохождение на GitHub проверяется после первого push (локально все шаги CI проходят, в том числе на свежем клоне).
- Для miniapp нет автоматического теста рендеринга (проверено вручную: build + Chromium, ошибок в консоли нет).
- ADR-0001 (инструменты и версии PHASE 00) в статусе **Proposed** — ожидает решения владельца.

## Next Allowed Phase

**01 only after owner approval.**
