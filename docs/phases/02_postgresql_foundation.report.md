# PHASE 02 REPORT — PostgreSQL Foundation

```text
Phase: 02 — PostgreSQL Foundation
Status: PASS
Date: 2026-09-25
Spec: docs/phases/02_postgresql_foundation.md (составлена Claude по решению владельца D-015)
```

## Implemented

- **`@roi-dealer/database`** (новый пакет, [ADR-0005](../ADR/0005-postgresql-driver-and-migrations.md)):
  - `createDatabase`: пул postgres.js; сессии в `TimeZone=UTC`, `application_name`; `transaction`, `ping`, `close`. Соединения открываются при первом запросе, уведомления PostgreSQL идут в логгер, а не в консоль.
  - `createDatabaseHealthCheck` для `HealthRegistry`; `loadDatabaseConfig` (`DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_SECONDS`).
  - Раннер миграций `loadMigrations` / `runMigrations`: имена `NNNN_name.sql`, SHA-256 (независимо от CRLF / LF), журнал `schema_migrations`, транзакция и `pg_advisory_xact_lock` на каждый файл. Раннер останавливается с `MigrationError` при изменённом файле, неизвестной применённой миграции или новом файле, который по номеру идёт перед уже применённым.
  - 13 репозиториев: `insert`, `getById`, `getByIds` (в порядке запроса); у 9 изменяемых сущностей — `update` с optimistic locking. Связи списков только дополняются. Каждая прочитанная строка проверяется доменной схемой.
  - Ошибки без значений строк: `NotFoundError`, `ConcurrencyError`, `ConstraintViolationError` (`kind`, `constraint`, `table`, `sqlState`), `DataIntegrityError`, `MigrationError`.
  - CLI `pnpm db:migrate`.
- **Миграция `0001_core_domain.sql`:**
  - 13 таблиц сущностей и 8 таблиц связей;
  - SQL-домены: текст с лимитами, коды стран и языков, URL, центы, актор, тип сущности;
  - CHECK-ограничения денег, времени и human gates; внешние ключи, в том числе составной «гипотеза той же возможности»; индексы на внешние ключи;
  - 51 триггер защиты истории: append-only, запрет удаления и `TRUNCATE`, version guard.
  - Карта правил — [`database/docs/schema.md`](../../database/docs/schema.md).
- **`apps/api`:** при заданном `DATABASE_URL` регистрирует проверку `database` в `GET /health` и закрывает пул при остановке; без `DATABASE_URL` работает как раньше.
- **CI:** сервис PostgreSQL 18 в job «Typecheck, lint, test, build»; шаг `pnpm db:migrate`; integration-тесты с `TEST_DATABASE_URL`.
- **Документы:**
  - спецификация и отчёт PHASE 02, ADR-0005 (Proposed), решение D-015;
  - [`docs/deploy/database.md`](../deploy/database.md): облачная БД в Railway, миграции, резервные копии, staging;
  - README пакета и каталога `database/`, правила миграций;
  - обновлены `TECH_STACK`, `SYSTEM_ARCHITECTURE`, `ROADMAP`, `README`, `CLAUDE.md`, `.env.example`, `infra/README`.
- **Этап A6** (одобрен вместе с фазой): [`docs/runbooks/`](../runbooks/README.md) — утечка токена или ключа, сервис не работает, рост расходов.

## Files created

- `packages/database/{package.json,tsconfig.json,README.md}`
- `packages/database/src/`: `config.ts`, `database.ts`, `errors.ts`, `executor.ts`, `index.ts`, `migrate-cli.ts`, `migrations.ts`, `repositories.ts`, `repository.ts`, `rows.ts`, `tables.ts`
- `database/migrations/0001_core_domain.sql`, `database/docs/schema.md`
- `docs/phases/02_postgresql_foundation.md`, `docs/phases/02_postgresql_foundation.report.md`
- `docs/ADR/0005-postgresql-driver-and-migrations.md`, `docs/deploy/database.md`
- `tests/support/database.ts`
- `tests/integration/database/`: `migrations.test.ts`, `repositories.test.ts`, `constraints.test.ts`, `core-loop.test.ts`
- `tests/unit/database/`: `config.test.ts`, `migrations.test.ts`, `errors.test.ts`

## Files modified

- `apps/api/src/{config.ts,main.ts}`, `apps/api/{package.json,tsconfig.json}`
- `package.json` (скрипт `db:migrate`, `@roi-dealer/database`), `pnpm-lock.yaml`, `tsconfig.json`
- `.github/workflows/ci.yml`, `.env.example`, `README.md`, `CLAUDE.md`
- `database/README.md`, `database/migrations/README.md`, `database/seeds/README.md` (`database/docs/README.md` заменён на `schema.md`)
- `docs/{CURRENT_STATE,OWNER_DECISIONS,ROADMAP,SYSTEM_ARCHITECTURE,TECH_STACK}.md`, `docs/ADR/README.md`, `docs/phases/README.md`, `infra/README.md`
- `tests/integration/api/process.test.ts`, `tests/unit/api/router.test.ts`, `tests/unit/packages/imports.test.ts`

## Database migrations

- `0001_core_domain` — схема 13 сущностей PHASE 01. Применяется к пустой БД в каждом integration-тесте, в CI и локально (`pnpm db:migrate`, повторный запуск — без изменений). Деструктивных изменений нет.

## Tests added

65 новых тестов (было 262, стало 327).

- **Миграции (8 integration + 8 unit):**
  - схема строится на пустой БД, повторный запуск ничего не меняет, два одновременных запуска применяют миграцию один раз;
  - изменённый файл, неизвестная применённая миграция и файл не по порядку останавливают раннер;
  - упавшая миграция откатывается целиком, в сообщении нет значений;
  - сессия работает в UTC;
  - имена и повторяющиеся номера файлов проверяются, checksum не зависит от CRLF / LF.
- **Репозитории (13):**
  - каждая из 13 сущностей сохраняется и читается обратно без отличий (`toStrictEqual`), включая отсутствующие необязательные поля;
  - порядок списков и `getByIds` сохраняется;
  - обновление версии, `ConcurrencyError` при устаревшей версии, `NotFoundError`;
  - запрет переписать связи;
  - точные суммы до `Number.MAX_SAFE_INTEGER` центов;
  - момент перехода на летнее время хранится в UTC без сдвига;
  - `DataIntegrityError` для строки, записанной в обход домена;
  - транзакции: общий коммит, откат при ошибке, работа после отклонённой записи (savepoint).
- **Ограничения БД в обход домена (23):**
  - внешние ключи, в том числе гипотеза чужой возможности;
  - некорректный UUID — без значения в ошибке;
  - коды стран, текст с пробелами и сверх лимита, NOT NULL, статусы, Evidence из будущего;
  - stop-loss > бюджета, нулевой расход, сумма за пределами безопасного целого;
  - денежное одобрение без суммы, одобрение без решения владельца, запуск эксперимента без одобрения, Reward для AI-агента;
  - изменение и удаление Evidence, удаление и `TRUNCATE` таблиц, удаление связи, версия не +1, подмена автора создания.
- **Сквозной сценарий DoD v0.1 в БД (1):** весь цикл §11 из PHASE 01. Каждый шаг читает нужное из БД (Pain валидируется по Evidence из БД, Reward считается по вкладам из БД) и сохраняет результат в транзакции. В конце всё читается обратно без отличий, итог расходов считается по строкам журнала из БД.
- **api (2 integration + 1 unit):** `/health` — `database: ok` с БД и HTTP 503 `down` без неё; пароль из `DATABASE_URL` не попадает в логи; конфигурация api принимает и проверяет `DATABASE_URL`.
- **Конфигурация и ошибки (8 unit):** `DATABASE_URL` проверяется без раскрытия значения (в том числе пароля), размер пула ограничен; ошибки не из PostgreSQL проходят без изменений, сообщения ошибок пакета не содержат значений.
- **Пакеты (1):** `@roi-dealer/database` импортируется.

## Test results

Все команды выполнены из корня в порядке CI (PostgreSQL 18.6 в Docker):

```text
pnpm install --frozen-lockfile   ok
pnpm typecheck                   ok
pnpm lint                        ok (0 warnings)
pnpm format:check                ok
pnpm test:unit                   Test Files 24 passed (24) · Tests 256 passed (256)
pnpm build                       ok
pnpm db:migrate                  applied: ["0001_core_domain"]; повторно: applied: [], already_applied: 1
pnpm test:integration            Test Files 8 passed (8) · Tests 71 passed (71)
docker compose … config --quiet  ok
```

После тестов на сервере не остаётся временных баз `roi_test_*`.

## Security implications

- SQL-инъекции через значения исключены: запросы — tagged templates postgres.js; имена таблиц и колонок подставляются как идентификаторы.
- Значения строк не попадают в ошибки и логи: `ConstraintViolationError` содержит только вид, имя ограничения, таблицу и SQLSTATE. Для классов 22 и 23 не копируется даже сообщение PostgreSQL: там бывают значения.
- `DATABASE_URL` не логируется, логгер его редактирует; проверено тестом процесса api.
- БД отклоняет нарушения human gates даже в обход кода: одобрение без суммы, запуск без одобрения, выплата без одобрения, Reward для AI.
- История защищена на уровне БД: неизменяемые записи и связи нельзя изменить или удалить, строки не удаляются.
- Учётные данные в CI и `compose.yaml` — только для локальной или временной БД.

## Cost implications

- $0 в этой фазе: одна open-source зависимость, облачная БД не создавалась.
- При создании облачной PostgreSQL в Railway (рекомендуется с 13b) — оплата по использованию в пределах лимита $20/мес (D-007); ограничения расходов в Railway уже настроены.

## Known limitations

- **Облачная БД не создана:** ей ещё некому пользоваться (см. «Scope decisions»). Инструкция готова; версию PostgreSQL и вкладку Backups в Railway нужно проверить при создании.
- **Миграции в облаке:** шаг деплоя появится в 13b вместе с первым облачным потребителем. Сейчас в Docker-образе бота нет ни миграций, ни раннера.
- **Что проверяет только домен:** минимальное число элементов в списках id (`evidenceIds ≥ 1` и т. п.) и существование объекта в полиморфной ссылке `subject`. Строка без обязательных связей не проходит чтение (`DataIntegrityError`).
- **Точность времени — миллисекунды** (`timestamptz(3)`), как у `Date.toISOString()`. Внешнее время с микросекундами округляется.
- **Прерванный тестовый прогон** может оставить базу `roi_test_*` на локальном сервере. Удаление: `pnpm infra:down && docker compose -f infra/docker/compose.yaml down --volumes`, либо `drop database` вручную.
- **ADR-0005 в статусе Proposed** до приёмки фазы.

## Technical debt

- NONE. Команды `tsx` с `--env-file-if-exists` печатают «.env not found», если файла нет: это косметика и поведение прежних dev-скриптов.

## Architecture deviations

- NONE:
  - стек не изменился: PostgreSQL остаётся источником истины;
  - драйвер и миграции выбраны через ADR, как требует `TECH_STACK.md`;
  - `database/seeds/` и `database/docs/README.md` из плана PHASE 00 заменены: seeds не нужны, документация — `schema.md`.

## Scope decisions

- **Реализовано:**
  - хранение всех 13 сущностей с ограничениями — фундамент для 03 (события в тех же транзакциях) и 13b (одобрения в пульте);
  - проверка БД в `/health` — по правилу протокола о health checks новых зависимостей.
- **Облачная БД и staging — отложены до 13b.** Сейчас их некому использовать, а пустая БД стоит денег из лимита $20 (Feature Kill Gate, §2.15). Инструкция готова; владелец может создать БД раньше.
- **Seeds — не делались:** тесты создают данные доменными фабриками во временной БД.
- **Списки, фильтры, поиск и журнал для пульта (D-010) — отложены** до 13b и PHASE 08: репозитории пока умеют только то, что нужно домену (`getById`, `getByIds`, `update`).
- **Строки не удаляются** (запрет на уровне БД). Удаление персональных данных по запросу (план PHASE 05) потребует отдельной миграции с approval владельца.

## Business hypothesis enabled by this phase

- «Владелец управляет системой с телефона» (13b): одобрение в Telegram теперь может стать надёжной записью. Решение владельца и изменение статуса сохраняются атомарно; повторное нажатие или гонка двух процессов не перезапишут данные (optimistic locking). БД не даст запустить эксперимент или выплату без одобрения, даже если в коде будет ошибка.

## Authoritative data paths verified

- Всё, что читается из PostgreSQL, проходит доменную схему до использования (§2.13); повреждённая строка — `DataIntegrityError`, а не молчаливое продолжение.
- Сквозной тест: валидация Pain — по Evidence из БД, расчёт Reward — по вкладам из БД, итог расходов — детерминированно в коде по строкам журнала из БД (§7.3): `$159.00`.
- Время: хранение и чтение в UTC проверены на моменте перехода на летнее время.

## Ready for next phase

YES — PHASE 03 (Event History) только после approval владельца. По порядку D-002 затем 13b: одобрения и стоп-кран в пульте, вместе с ними облачная PostgreSQL и staging.
