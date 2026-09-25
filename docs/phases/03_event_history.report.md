# PHASE 03 REPORT — Event History

```text
Phase: 03 — Event History
Status: PASS
Date: 2026-09-25
Spec: docs/phases/03_event_history.md (составлена Claude по решению владельца D-016)
```

## Implemented

- **`@roi-dealer/events`** (был placeholder):
  - 22 типа событий: `<entity>.created` для 13 сущностей, `<entity>.updated` для 9 изменяемых;
  - схемы конверта `newEventSchema` / `storedEventSchema`: тип соответствует сущности, `created` ⇔ версия 1;
  - `correlationIdSchema` (формат `x-correlation-id` и `tg-update-<id>`), `idempotencyKeySchema`.
- **Миграция `0002_event_history.sql`:**
  - таблица `events`: глобальный порядок `position`, `UNIQUE (aggregate_type, aggregate_id, aggregate_version)`, проверка соответствия типа сущности и версии, JSON-объект в `payload`, индексы по времени и `correlation_id`;
  - append-only: `UPDATE`, `DELETE` и `TRUNCATE` событий отклоняются;
  - 13 отложенных constraint trigger `<table>_requires_event`: при `COMMIT` у каждой вставленной или изменённой строки сущности должно быть событие того же типа и версии, иначе транзакция не фиксируется;
  - таблица `idempotency_keys`: результат записывается один раз.
- **`@roi-dealer/database`:**
  - `insert` пишет `<entity>.created` (актор — `createdBy`, снимок); сущности с версиями сохраняются только в версии 1, иначе `InvalidWriteError` — в истории нет пропусков;
  - `update(entity, actor)` блокирует строку (`FOR UPDATE`), проверяет версию, пишет `<entity>.updated` с предыдущим статусом и актором перехода;
  - `database.transaction(work, { correlationId })` — один `correlation_id` на все события транзакции;
  - `database.command({ name, idempotencyKey, correlationId }, work)` — ровно одно выполнение на ключ, повтор получает сохранённый результат;
  - `database.events.history(aggregate)` и `list({ from, to, aggregateType, after, limit })` — прочитанные события проверяются схемой;
  - новые ошибки: `InvalidWriteError`, вид `missing_event` у `ConstraintViolationError`.
- **Документы:**
  - спецификация и отчёт PHASE 03, решение D-016, ADR-0005 → Accepted;
  - раздел Event History в `database/docs/schema.md`;
  - README пакетов `events` и `database`;
  - обновлены `SYSTEM_ARCHITECTURE`, таблица применения конституции, `CLAUDE.md`, `ROADMAP`, `CURRENT_STATE`, `README`.

## Files created

- `database/migrations/0002_event_history.sql`
- `packages/database/src/event-store.ts`
- `docs/phases/03_event_history.md`, `docs/phases/03_event_history.report.md`
- `tests/integration/database/events.test.ts`, `tests/unit/events/contracts.test.ts`

## Files modified

- `packages/events/{src/index.ts,package.json,tsconfig.json,README.md}`
- `packages/database/src/{database.ts,errors.ts,index.ts,repositories.ts,repository.ts}`, `packages/database/{package.json,tsconfig.json,README.md}`
- `tsconfig.json`, `pnpm-lock.yaml`
- `tests/integration/database/{core-loop,repositories,constraints,migrations}.test.ts`
- `database/docs/schema.md`, `database/migrations/README.md`
- `docs/{CURRENT_STATE,OWNER_DECISIONS,ROADMAP,SYSTEM_ARCHITECTURE,CLAUDE_CONSTITUTION}.md`, `docs/ADR/{0005-postgresql-driver-and-migrations,README}.md`, `docs/phases/README.md`, `CLAUDE.md`, `README.md`

## Database migrations

- `0002_event_history` — таблицы `events` и `idempotency_keys`, триггеры. Миграция `0001` не изменялась (контрольная сумма совпадает). Деструктивных изменений нет. Существующие строки не проверяются задним числом: правило «нет изменения без события» действует для новых вставок и изменений.

## Tests added

36 новых тестов (было 327, стало 363).

- **Event History (19 integration):**
  - создание — событие с актором и снимком; каждая версия — событие с предыдущим статусом и актором;
  - общий `correlation_id` транзакции; откат убирает изменение вместе с событием;
  - сущность в версии > 1 без предыдущих не сохраняется; некорректный `correlation_id` отклоняется;
  - БД не фиксирует изменение и новую строку без события;
  - события нельзя изменить, удалить или очистить; второе событие той же версии и событие не своей сущности или версии отклоняются;
  - `list` — период, порядок, постраничное чтение, фильтр по сущности;
  - команды: одно выполнение и сохранённый результат для повтора; одновременные повторы — одно выполнение; упавшая команда не блокирует повтор; ключ другой команды и некорректный ключ отклоняются; результат не перезаписывается.
- **Контракты (17 unit):** типы событий, схема конверта (чужая сущность, `created` не в версии 1, время не в UTC, лишние поля, пустой `payload`), форматы correlation id и ключей.
- **Обновлены тесты PHASE 02:**
  - `update(entity, actor)`; сущности сохраняются по версиям;
  - сквозной сценарий DoD v0.1 проверяет полную историю: события всех версий, снимки равны сохранённым версиям, у решения владельца общий `correlation_id` операции, событий ровно столько, сколько сохранённых версий.

## Test results

Все команды выполнены из корня в порядке CI (PostgreSQL 18.6 в Docker):

```text
pnpm install --frozen-lockfile   ok
pnpm typecheck                   ok
pnpm lint                        ok (0 warnings)
pnpm format:check                ok
pnpm test:unit                   Test Files 25 passed (25) · Tests 273 passed (273)
pnpm build                       ok
pnpm db:migrate                  applied: ["0001_core_domain","0002_event_history"]; повторно: applied: [], already_applied: 2
pnpm test:integration            Test Files 9 passed (9) · Tests 90 passed (90)
```

После тестов на сервере не остаётся временных баз `roi_test_*`.

## Security implications

- **Аудит изменений (§2.11):** кто, когда, какая версия, в рамках какого запроса. Изменить или удалить событие нельзя даже прямым SQL; изменение сущности в обход event store не фиксируется.
- **Защита от повторного выполнения:** повтор команды не повторяет трату или решение, в том числе при одновременной доставке.
- **Входные значения:** `correlation_id` и ключи идемпотентности проверяются форматом до записи, это защищает журнал от инъекций в логи и отчёты.
- **Содержимое событий:** снимки сущностей хранятся в `payload`. Персональных данных в сущностях сейчас нет (требование PHASE 05 — не сохранять их в Evidence).

## Cost implications

- $0: новых зависимостей и сервисов нет.
- Объём БД растёт на одно событие на каждую версию сущности. При объёмах ближайших фаз это килобайты — мегабайты.

## Known limitations

- **Время в журнале** — `occurredAt` (время по домену); порядок — `position` (порядок записи). Две транзакции, начатые одновременно, получают `position` в порядке вставки события, а не фиксации. Для журнала за период это неважно; для чтения «новых событий с позиции N» в реальном времени понадобится отдельное решение (не нужно до подписок на события).
- **Снимки в форме своего времени:** при изменении доменной схемы старые снимки не переписываются. Их преобразование при чтении — когда понадобится.
- **Удаление персональных данных из истории (GDPR / CCPA)** не предусмотрено. Требование PHASE 05 не собирать такие данные в Evidence это снимает; при необходимости — отдельная миграция с approval.
- **Аудит действий без изменения состояния** (просмотры, отказанные попытки) — с правами в PHASE 04.
- **Облачная БД** по-прежнему не создана: рекомендуемый момент — 13b.

## Technical debt

- NONE.

## Architecture deviations

- NONE:
  - Event History хранится в PostgreSQL (§2.1, §2.2); контракты — `@roi-dealer/events`, как было запланировано в PHASE 00;
  - новых зависимостей нет.
- **Изменение API PHASE 02:** `update(entity)` → `update(entity, actor)`. Сущность не хранит, кто её изменил, а событию нужен актор. Все вызовы и тесты обновлены.

## Scope decisions

- **Реализовано:**
  - события на все записи, гарантия БД «нет изменения без события», неизменяемость истории;
  - журнал за период с постраничным чтением и история сущности — это прямые данные для кнопок «🧾 Журнал» и «🕘 История» (D-010);
  - идемпотентные команды — требование плана пульта «повторное нажатие не выполняет действие дважды».
- **Отложено:**
  - проекции, подписки на события и публикация во внешние системы — пока нет потребителя (§2.15);
  - кнопки пульта — 13b; аудит чтения — PHASE 04;
  - `causation_id` (связь событие → событие) — пока хватает `correlation_id`.

## Business hypothesis enabled by this phase

- «Владелец управляет системой с телефона» (13b): решение из Telegram оставляет неизменяемый след с актором `owner` и id обновления Telegram, а повторное нажатие ✅ не одобрит трату дважды. Журнал за день / неделю / месяц можно строить прямо из `events.list`.

## Authoritative data paths verified

- Сквозной тест DoD v0.1: история каждой сущности читается из БД, снимки совпадают с сохранёнными версиями, число событий равно числу сохранённых версий.
- Все события при чтении проверяются схемой конверта; повреждённая строка — `DataIntegrityError`, а не молчаливое использование.

## Ready for next phase

YES — 13b (одобрения и стоп-кран в пульте, ранний шаг PHASE 13 по D-002) только после approval владельца. Вместе с 13b — облачная PostgreSQL, шаг миграций при деплое и staging.
