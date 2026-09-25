# PHASE 02 — PostgreSQL Foundation

> **Основание:** playbook v1.1 §7 («migrations, repositories, constraints, UUID, UTC»), §2.1 Source of Truth, §2.2, §2.13; [`ROADMAP.md`](../ROADMAP.md) этап B; решения владельца D-002, D-005, D-007, D-014 п.3, D-015.
> Спецификацию составил Claude по поручению владельца (D-003, D-015). Инструменты — [ADR-0005](../ADR/0005-postgresql-driver-and-migrations.md). **Отчёт:** [02_postgresql_foundation.report.md](02_postgresql_foundation.report.md).

## Objective

Сущности PHASE 01 хранятся в PostgreSQL: версионированные миграции, ограничения в самой БД, репозитории с optimistic locking, UUID-идентификаторы и время в UTC. Всё, что читается из БД, проверяется доменными схемами до использования.

## Business purpose

Следующие шаги D-002 — Event History (03) и одобрения со стоп-краном в пульте (13b) — меняют состояние системы и должны переживать перезапуски. Без надёжного хранения кнопка «Одобрить» в Telegram ничего не значит. Фаза не добавляет пользовательских функций: это обязательная инфраструктурная потребность для гипотезы «владелец управляет системой с телефона» (13b).

## Scope

### 1. Пакет `@roi-dealer/database`

| Часть        | Что делает                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Конфигурация | `DATABASE_URL` (`postgres://` / `postgresql://`), `DATABASE_POOL_MAX` (по умолчанию 5), `DATABASE_CONNECT_TIMEOUT_SECONDS` (10) — через `loadConfig`                                                    |
| Подключение  | `createDatabase`: пул, сессия с `TimeZone=UTC` и `application_name`, `ping`, `transaction`, `close`; URL и пароль не логируются                                                                         |
| Health       | `createDatabaseHealthCheck(database)` для `HealthRegistry`                                                                                                                                              |
| Миграции     | `loadMigrations(dir)`, `runMigrations(sql, migrations)`: журнал `schema_migrations` с SHA-256, транзакция и `pg_advisory_xact_lock` на каждую миграцию, остановка при изменённом или неизвестном файле  |
| Репозитории  | 13 репозиториев: `insert`, `getById`, `getByIds` (в порядке запроса); для 9 изменяемых сущностей — `update` с optimistic locking                                                                        |
| Ошибки       | `NotFoundError`, `ConcurrencyError` (версия устарела), `ConstraintViolationError` (SQLSTATE и имя constraint, без значений), `DataIntegrityError` (строка не проходит доменную схему), `MigrationError` |

Репозитории принимают и возвращают только доменные объекты. Новую версию сущности создаёт домен (`transition`, `version + 1`); репозиторий сохраняет её, только если в БД лежит предыдущая версия.

### 2. Схема: миграция `0001_core_domain.sql`

| Домен                                                      | PostgreSQL                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Id (UUID)                                                  | `uuid` PRIMARY KEY; id всегда задаёт приложение (`uuidv7()` из `@roi-dealer/shared`)                                                               |
| Timestamp (UTC)                                            | `timestamptz(3)` — точность до миллисекунд, как `Date.toISOString()`; сессия в UTC                                                                 |
| Money (USD, центы, D-005)                                  | `bigint` с суффиксом `_usd_cents`, в пределах безопасного целого JavaScript                                                                        |
| Actor                                                      | пара колонок `*_type` / `*_id` (SQL-домены `actor_type`, `actor_id`)                                                                               |
| Списки id (evidenceIds, painIds, contributionIds…)         | таблицы связей с внешними ключами и `position` (порядок сохраняется)                                                                               |
| Списки кодов (markets, languages, tags)                    | `text[]` с проверками формата, уникальности и количества (встроенный тип массива: драйвер читает и пишет его без знания о собственных типах схемы) |
| Вложенные объекты (Metric, valueProposition, buildBudget…) | отдельные колонки с префиксом                                                                                                                      |
| Полиморфная ссылка `EntityRef` (subject)                   | `subject_type` + `subject_id` без внешнего ключа (тип проверяется, существование — доменом и PHASE 03)                                             |
| Статус                                                     | `text` + CHECK по списку статусов домена                                                                                                           |
| Ограничения длины текста                                   | SQL-домены `text_100` … `text_50000`: непустой, без пробелов по краям, не длиннее лимита домена                                                    |

Таблицы: `sources`, `evidence`, `signals`, `pains`, `opportunities`, `decisions`, `approval_requests`, `hypotheses`, `experiments`, `cost_entries`, `contributions`, `rewards`, `knowledge_assets` и связи `signal_evidence`, `pain_signals`, `pain_evidence`, `opportunity_pains`, `decision_evidence`, `experiment_result_assets`, `reward_contributions`, `knowledge_asset_evidence`.

### 3. Правила в самой БД

БД — последняя линия защиты: она отклоняет недопустимые данные, даже если запись пришла в обход домена (ручной SQL, ошибка в коде).

1. **Типы и перечисления:** статусы, виды, категории, коды стран и языков, границы текста, UUID.
2. **Ссылочная целостность:** внешние ключи для всех ссылок по id, включая связи списков; эксперимент ссылается на гипотезу **той же** возможности (составной ключ).
3. **Деньги:** суммы расходов, бюджетов, stop-loss и вознаграждений > 0; цена ≥ 0; stop-loss ≤ бюджета.
4. **Время:** `observedAt ≤ createdAt` у Evidence; `expiresAt > createdAt` у ApprovalRequest; `updatedAt ≥ createdAt`.
5. **Human gates:** у одобрений с деньгами есть сумма; решение по ApprovalRequest записано тогда и только тогда, когда он `approved` / `rejected`; эксперимент после отправки на одобрение и Reward после одобрения ссылаются на ApprovalRequest; Reward только людям (`owner` / `member`); выплаченный Reward — с датой и референсом платежа.
6. **Каждый цикл оставляет актив:** завершённый эксперимент имеет итог.
7. **Append-only (§2.2):** строки Evidence, Decision, CostEntry, KnowledgeAsset и их связей нельзя изменить или удалить — триггер отклоняет `UPDATE` и `DELETE`.
8. **Optimistic locking:** при изменении строки `version` растёт ровно на 1; `id`, `created_at` и автор создания не меняются — триггер отклоняет нарушения.

Правила поведения (кто может принимать решения, допустимые переходы статусов, пять разных гипотез, покрытие бюджета одобрением) остаются в домене: они зависят от актора и контекста действия.

### 4. Запуск и окружения

- `pnpm db:migrate` — применить миграции к `DATABASE_URL` (локально — PostgreSQL из `pnpm infra:up`).
- `apps/api`: если задан `DATABASE_URL`, регистрирует проверку `database` в `GET /health` и закрывает пул при остановке. Без `DATABASE_URL` работает как раньше.
- CI: сервис PostgreSQL 18 в GitHub Actions; каждый файл integration-тестов создаёт свою чистую БД, применяет миграции и удаляет её в конце.
- Облачная БД и staging (D-014 п.3): инструкция [`docs/deploy/database.md`](../deploy/database.md) — создание PostgreSQL в Railway, `DATABASE_URL`, миграции, резервные копии и восстановление. Создаёт БД владелец.

### 5. Документация

`database/docs/schema.md` (таблицы, связи, соответствие правил домена и constraints), `database/migrations/README.md` (как писать миграции), обновления `TECH_STACK.md`, `SYSTEM_ARCHITECTURE.md`, `CURRENT_STATE.md`.

## Out of scope

- **Создание облачной БД сейчас.** В этой фазе у БД нет облачного потребителя: бот не читает и не пишет данные, api не развёрнут. Пустая БД стоила бы денег из лимита $20 (D-007), ничего не храня (Feature Kill Gate, §2.15). Инструкция готова; рекомендуемый момент — вместе с 13b, когда бот начнёт сохранять одобрения. Владелец может создать её раньше.
- Event History, аудит, идемпотентность (PHASE 03); пользователи и права (PHASE 04).
- Поиск, списки и фильтры для пульта (13b, PHASE 08); seeds — тесты создают данные доменными фабриками.
- Проверка существования объекта полиморфной ссылки (`subject`) внешним ключом.

## Constraints

- Одна новая runtime-зависимость — `postgres` (ADR-0005).
- `@roi-dealer/domain` не меняется и остаётся без I/O.
- Миграции только вперёд; применённый файл не редактируется.
- Integration-тесты работают с настоящим PostgreSQL 18, без моков драйвера.

## Acceptance criteria

1. `pnpm db:migrate` на пустой БД создаёт схему; повторный запуск ничего не меняет; изменённый после применения файл или неизвестная миграция в БД — ошибка; два одновременных запуска применяют миграцию один раз.
2. Для каждой сущности: `insert` → `getById` возвращает тот же доменный объект; `getByIds` сохраняет порядок; `update` с верной версией сохраняет изменения; устаревшая версия → `ConcurrencyError`; отсутствующая строка → `NotFoundError`.
3. БД отклоняет недопустимые данные в обход домена: примеры для CHECK, внешних ключей, append-only и version guard.
4. Время сохраняется и читается в UTC без сдвигов; сессия работает в `TimeZone=UTC`.
5. Сквозной сценарий DoD v0.1 из PHASE 01 сохраняется в БД целиком (в транзакциях) и читается обратно без расхождений.
6. `GET /health` api показывает `database: ok`, а при недоступной БД — `down` и HTTP 503.
7. typecheck, lint, format, все тесты, build — зелёные; CI зелёный с сервисом PostgreSQL.
