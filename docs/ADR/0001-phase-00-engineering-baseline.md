# ADR-0001: Инженерный baseline PHASE 00

- **Status:** Proposed
- **Date:** 2026-09-24
- **Approved by:** — (ожидает решения владельца вместе с приёмкой PHASE 00)

## Context

Playbook v1.1 фиксирует канонический стек (TypeScript, React, PostgreSQL, Zod, Temporal, pnpm monorepo, Vitest, ESLint, Prettier), но оставляет открытыми конкретные инструменты и версии. PHASE 00 должна создать воспроизводимый фундамент, не добавляя лишних зависимостей и не принимая решений, которые принадлежат следующим Phase.

## Decision

1. **Monorepo:** pnpm workspaces; `apps/*` и `packages/*` — workspace-пакеты `@roi-dealer/*`; `workflows/` — обычные каталоги до подключения Temporal.
2. **TypeScript 6.0** (`~6.0.3`), а не 7.x: typescript-eslint 8.x (type-aware lint) поддерживает TypeScript `<6.1`. Переход на 7.x — отдельным ADR, когда появится поддержка в typescript-eslint.
3. **Строгий TypeScript** сверх `strict`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `verbatimModuleSyntax`.
4. **Сборка через project references** (`tsc -b`) с ESM / `NodeNext`.
5. **Разрешение пакетов через export condition `@roi-dealer/source`**: dev и тесты читают `src/`, runtime и build — `dist/`. Без `paths` aliases.
6. **HTTP: `node:http`** для `/health`. Фреймворк (Fastify / Hono / др.) выбирается отдельным ADR, когда понадобятся routing, middleware, auth.
7. **Logging:** собственный JSON logger без зависимостей с редактированием секретов за интерфейсом `Logger`, чтобы позже его можно было заменить (например, на pino) без изменения потребителей.
8. **PostgreSQL 18** (`postgres:18-alpine`): нативный `uuidv7()` для time-ordered UUID (Event History, PHASE 02–03). Порт открыт только на `127.0.0.1`.
9. **Tests:** Vitest 5, проекты `unit` (in-process, без сокетов и процессов) и `integration` (реальные HTTP-сокеты и OS-процессы); тесты в корневом `tests/`.
10. **Lint / format:** ESLint 10 flat config + typescript-eslint `recommendedTypeChecked`, `no-console: error`; Prettier.
11. **Dev runner:** tsx (`tsx watch --conditions=@roi-dealer/source`).
12. **Supply chain:** lifecycle-скрипты зависимостей заблокированы (`onlyBuiltDependencies: []`); lockfile коммитится; CI использует `--frozen-lockfile`.

## Alternatives

| Вариант                                           | Почему не выбран                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| TypeScript 7.0 (нативный компилятор)              | Несовместим с typescript-eslint 8.x; потеря type-aware lint                                              |
| `paths` aliases в tsconfig                        | Скрытая связанность (запрещено TASK 00.6); расхождение между tsc, tsx и Vitest                           |
| Сборка пакетов перед каждым dev-запуском / тестом | Медленно, риск тестировать устаревший `dist/`                                                            |
| Fastify / Express уже в PHASE 00                  | Лишняя зависимость для одного endpoint; выбор фреймворка — отдельное решение                             |
| pino                                              | Зрелый, но ещё одна зависимость ради минимального набора полей; остаётся заменой за интерфейсом `Logger` |
| PostgreSQL 17                                     | Нет встроенного `uuidv7()`                                                                               |
| Jest                                              | Хуже поддержка ESM / TypeScript; playbook предпочитает Vitest                                            |

## Consequences

- **+** Воспроизводимая установка, строгая типизация, тесты без предварительной сборки, единый источник правды о связях пакетов.
- **+** Минимальный набор runtime-зависимостей (`zod`, `react`, `react-dom`).
- **−** `pnpm typecheck` обновляет `dist/` (особенность `tsc -b`).
- **−** Собственный logger нужно поддерживать самим (≈170 строк, покрыт тестами).
- **−** `exactOptionalPropertyTypes` требует аккуратности при работе со сторонними типами.

## Rollback

Каждый пункт откатывается локально:

- TypeScript: изменить версию в корневом `package.json`.
- Logger: заменить реализацию `createLogger`, сохранив интерфейс `Logger`.
- HTTP: `apps/api/src/server.ts` — единственный адаптер `node:http`; `router.ts` от транспорта не зависит.
- PostgreSQL: сменить образ в `infra/docker/compose.yaml` (до появления данных — без миграции).
