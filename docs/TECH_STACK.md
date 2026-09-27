# ROI Dealer — Tech Stack

> **Источник канонического стека:** Implementation Playbook v1.1, §4.
> Изменение канонического стека — только через ADR с approval владельца.
> Конкретные инструменты PHASE 00 зафиксированы в [ADR-0001](ADR/0001-phase-00-engineering-baseline.md) (Accepted), PostgreSQL-драйвер и миграции — в [ADR-0005](ADR/0005-postgresql-driver-and-migrations.md) (Proposed, принимается с приёмкой PHASE 02).

## Канонический стек v1

- Runtime: TypeScript
- Frontend: React + TypeScript
- Control interface: Telegram Mini App
- Backend: TypeScript modular monolith
- Database: PostgreSQL
- Validation: Zod
- Workflow Engine: Temporal
- Storage: S3-compatible object storage
- AI Runtime: Provider abstraction + Model Router + structured outputs + cost tracking
- Integrations: official APIs / permitted connectors
- n8n: только внешний integration layer, не core orchestrator
- Infrastructure: cloud-first
- Secrets: managed Secret Manager / Vault
- Observability: structured logs + metrics + tracing + alerts
- Repository: monorepo

**Запрещено без ADR:** MongoDB вместо PostgreSQL, backend на Python, n8n как core orchestrator, привязка домена к конкретному AI-провайдеру.

## Инструменты, используемые сейчас (PHASE 00)

| Область         | Инструмент                            | Версия                    | Примечание                                                                                                                   |
| --------------- | ------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Node.js                               | 22 LTS (`>=22.12`)        | `.nvmrc`, `engines`                                                                                                          |
| Package manager | pnpm workspaces                       | 10.33 (`packageManager`)  | lifecycle-скрипты зависимостей заблокированы                                                                                 |
| Язык            | TypeScript                            | `~6.0.3`                  | **Не 7.x:** typescript-eslint 8.x поддерживает только `<6.1`                                                                 |
| Validation      | Zod                                   | `^4.6`                    | конфигурация процессов; далее — все контракты                                                                                |
| Tests           | Vitest                                | `^5.0`                    | проекты `unit` и `integration`                                                                                               |
| Lint            | ESLint + typescript-eslint            | `^10.11` / `^8.70`        | flat config, type-aware правила                                                                                              |
| Format          | Prettier                              | `^3.9`                    | `eslint-config-prettier` отключает конфликтующие правила                                                                     |
| Dev runner      | tsx                                   | `^4.23`                   | `pnpm dev` для api / worker, integration-тесты процессов                                                                     |
| Frontend        | React + Vite + `@vitejs/plugin-react` | `^19.3` / `^8.3` / `^6.1` | только `apps/miniapp`                                                                                                        |
| HTTP            | `node:http`                           | встроен                   | фреймворк не выбран — решение через ADR в Phase, где понадобится routing / middleware                                        |
| Logging         | собственный JSON logger               | —                         | `@roi-dealer/observability`, без зависимостей                                                                                |
| Database        | PostgreSQL                            | 18 (`postgres:18-alpine`) | локально и в CI; сессии в UTC                                                                                                |
| DB driver       | `postgres` (postgres.js)              | `^3.4.9`                  | без зависимостей; только через `@roi-dealer/database`; [ADR-0005](ADR/0005-postgresql-driver-and-migrations.md)              |
| Migrations      | SQL-файлы + собственный раннер        | —                         | `database/migrations/`, `pnpm db:migrate`; SHA-256 и advisory lock; [ADR-0005](ADR/0005-postgresql-driver-and-migrations.md) |
| Local infra     | Docker Compose                        | v2+                       | `infra/docker/compose.yaml`                                                                                                  |
| CI              | GitHub Actions                        | —                         | `.github/workflows/ci.yml`                                                                                                   |
| Hosting miniapp | GitHub Pages                          | —                         | `.github/workflows/miniapp-pages.yml` после зелёного CI; [ADR-0002](ADR/0002-miniapp-hosting-github-pages.md)                |
| Telegram        | Bot API через собственный клиент      | —                         | `@roi-dealer/telegram` (`fetch` + Zod), long polling; [ADR-0003](ADR/0003-early-telegram-owner-bot.md)                       |
| Hosting bot     | Docker-образ `apps/bot/Dockerfile`    | `node:22-alpine`          | любой container-хостинг (рекомендуется Railway); [deploy guide](deploy/telegram-bot.md)                                      |

### Ещё не подключено (по плану)

| Компонент                                | Когда                                          | Требование                                                                |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| PostgreSQL в облаке, резервные копии     | Сейчас: бот 13b готов к БД                     | [инструкция](deploy/database.md); создаёт владелец                        |
| Temporal (server + SDK)                  | Перед первым durable workflow                  | ADR; сервис в Docker Compose                                              |
| S3-compatible storage                    | Первая потребность (Evidence snapshots, media) | ADR; сервис в Docker Compose                                              |
| AI providers                             | PHASE 09                                       | только через `@roi-dealer/ai-runtime`                                     |
| Telegram Mini App SDK, `initData` на api | PHASE 13                                       | данные в Mini App только после проверки подписи Telegram на стороне `api` |
| Metrics, tracing, alerts                 | Reliability System                             | совместимо с текущим logger / correlation id                              |

## TypeScript

- Общие опции — `tsconfig.base.json`: `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`, source maps и declaration maps.
- Модули: ESM (`"type": "module"`), `module` / `moduleResolution`: `NodeNext` (Node-пакеты), `Bundler` (miniapp).
- Сборка — **project references** (`tsc -b`). Корневой `tsconfig.json` — solution file со ссылками на все проекты, включая `apps/miniapp` и `tests` (они проверяются без emit).
- `pnpm typecheck` = `tsc -b`: проверяет все проекты и инкрементально обновляет `dist/` пакетов (нужно для project references).

### Разрешение workspace-пакетов

Каждый пакет публикует в `package.json`:

```json
"exports": {
  ".": {
    "@roi-dealer/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

- **Runtime / build** (`node dist/main.js`, `tsc -b`) используют `dist/`.
- **Dev и тесты** включают условие `@roi-dealer/source` и читают исходники напрямую, без предварительной сборки:
  - `tsx --conditions=@roi-dealer/source` (`pnpm dev`, integration-тесты процессов);
  - Vitest: `resolve.conditions` в `vitest.config.ts`;
  - typecheck тестов: `customConditions` в `tests/tsconfig.json`.
- TypeScript `paths` aliases не используются: единственный источник правды о связях — `package.json` пакетов.

## Политика зависимостей

1. Новая зависимость допускается, только если без неё нельзя выполнить задачу текущей Phase (Feature Kill Gate, §2.15); причина указывается в Phase Report.
2. Runtime-зависимости сейчас: `zod`, `react`, `react-dom`, `postgres` (PHASE 02, ADR-0005). Всё остальное — dev-инструменты. Telegram-интеграция не добавляет зависимостей.
3. Install-скрипты зависимостей не выполняются (`onlyBuiltDependencies: []`). Разрешение — только после review, с записью в `pnpm-workspace.yaml`.
4. `pnpm-lock.yaml` коммитится; CI использует `--frozen-lockfile`.
