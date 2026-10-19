# Схема базы данных

> Миграции [`0001_core_domain.sql`](../migrations/0001_core_domain.sql) (PHASE 02), [`0002_event_history.sql`](../migrations/0002_event_history.sql) (PHASE 03) [`0003_system_control.sql`](../migrations/0003_system_control.sql) (13b) и [`0004_identity_access.sql`](../migrations/0004_identity_access.sql) (PHASE 04). Сущности и правила — [спецификация PHASE 01](../../docs/phases/01_core_domain.md); хранение — [PHASE 02](../../docs/phases/02_postgresql_foundation.md); история — [PHASE 03](../../docs/phases/03_event_history.md); стоп-кран — [13b](../../docs/phases/13b_owner_approvals.md); доступ — [PHASE 04](../../docs/phases/04_identity_access.md).

## Кто за что отвечает

| Слой                   | Отвечает за                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@roi-dealer/domain`   | Поведение: кто может решать, допустимые переходы статусов, пять разных гипотез, покрытие бюджета одобрением, Evidence first |
| PostgreSQL (эта схема) | Структура: типы, перечисления, ссылки, деньги, время, согласованность human gates, неизменяемость истории, версии           |
| `@roi-dealer/database` | Перевод строк в доменные объекты и обратно, проверка прочитанного доменной схемой, optimistic locking, транзакции           |

## Таблицы

```text
sources ─┬─< source_snapshots ─< evidence (snapshot_id + source_id, PHASE 05)
         ├─< evidence >──────────────┬─< signal_evidence >── signals ─< pain_signals >── pains
         │                           ├─< pain_evidence >────────────────────────────────── pains
         │                           ├─< decision_evidence >── decisions
         │                           └─< knowledge_asset_evidence >── knowledge_assets
pains ─< opportunity_pains >── opportunities ─< hypotheses ─< experiments ─< experiment_result_assets >── knowledge_assets
opportunities.parent_id → opportunities       opportunities.last_decision_id → decisions
experiments.approval_request_id → approval_requests      rewards.approval_request_id → approval_requests
cost_entries → opportunities / hypotheses / experiments / approval_requests / cost_entries (reversal_of)
rewards ─< reward_contributions >── contributions
```

| Таблица             | Сущность        | Вид         | Связи списков                                                      |
| ------------------- | --------------- | ----------- | ------------------------------------------------------------------ |
| `sources`           | Source          | версии      | —                                                                  |
| `evidence`          | Evidence        | append-only | —                                                                  |
| `signals`           | Signal          | версии      | `signal_evidence` (evidenceIds)                                    |
| `pains`             | Pain            | версии      | `pain_signals`, `pain_evidence`                                    |
| `opportunities`     | Opportunity     | версии      | `opportunity_pains` (painIds)                                      |
| `decisions`         | Decision        | append-only | `decision_evidence`                                                |
| `approval_requests` | ApprovalRequest | версии      | —                                                                  |
| `hypotheses`        | Hypothesis      | версии      | —                                                                  |
| `experiments`       | Experiment      | версии      | `experiment_result_assets` (result.assetIds)                       |
| `cost_entries`      | CostEntry       | append-only | —                                                                  |
| `contributions`     | Contribution    | версии      | —                                                                  |
| `rewards`           | Reward          | версии      | `reward_contributions` (contributionIds)                           |
| `knowledge_assets`  | KnowledgeAsset  | append-only | `knowledge_asset_evidence` (links.evidenceIds)                     |
| `system_controls`   | SystemControl   | версии      | — (одна строка `automation`: стоп-кран, 13b)                       |
| `principals`        | Principal       | версии      | — (личности агентов, интеграций и участников, PHASE 04)            |
| `source_snapshots`  | SourceSnapshot  | append-only | — (загрузки из источников каталога, PHASE 05)                      |
| `access_log`        | —               | append-only | просмотры пульта и отказы в доступе (PHASE 04)                     |
| `ai_calls`          | —               | append-only | вызовы AI: токены, стоимость, итог (PHASE 09)                      |
| `events`            | —               | append-only | Event History: событие на каждую версию каждой сущности (PHASE 03) |
| `idempotency_keys`  | —               | служебная   | команды, выполненные ровно один раз, и их результат (PHASE 03)     |
| `schema_migrations` | —               | служебная   | журнал раннера миграций                                            |

## Соглашения

| Домен                      | PostgreSQL                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Id                         | `uuid`; id всегда передаёт приложение (`uuidv7()` из `@roi-dealer/shared`), значения по умолчанию в БД нет |
| Timestamp                  | `timestamptz(3)`: миллисекунды, как `Date.toISOString()`; сессия в `UTC`                                   |
| Money (USD)                | `*_usd_cents` типа `usd_cents` — `bigint` в пределах `Number.MAX_SAFE_INTEGER`                             |
| Actor                      | `*_type` (`actor_type`) + `*_id` (`actor_id`)                                                              |
| Текст с лимитом            | домены `text_32` … `text_50000`: непустой, без пробелов по краям, не длиннее лимита                        |
| Коды стран, языки, теги    | `country_code`, `language_tag` для одного значения; `text[]` с проверкой формата для списка                |
| Список id                  | таблица связи: `(parent_id, child_id)` — первичный ключ, `position` хранит порядок                         |
| Вложенный объект           | колонки с префиксом: `value_*`, `success_metric_*`, `build_max_*`, `result_*`, `decided_*`, `paid_at`…     |
| Полиморфная ссылка subject | `subject_type` + `subject_id` без внешнего ключа                                                           |

## Правила домена в ограничениях БД

| Правило (PHASE 01)                                               | Ограничение                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Статусы, виды, категории                                         | `CHECK (… IN (…))` в каждой таблице                                                                     |
| Evidence → Source, связи списков, lineage                        | внешние ключи; `experiments_hypothesis_fkey` — гипотеза той же возможности                              |
| Stop-loss ≤ бюджета                                              | `hypotheses_stop_loss_within_budget`, `experiments_stop_loss_within_budget`                             |
| Суммы > 0 (цена ≥ 0)                                             | `CHECK` на колонках `*_usd_cents`                                                                       |
| Evidence не из будущего                                          | `evidence_observed_not_after_created`                                                                   |
| Одобрение имеет срок                                             | `approval_requests_expires_after_created`                                                               |
| Денежные одобрения содержат сумму (D-006)                        | `approval_requests_amount_required`                                                                     |
| Решение по одобрению записано ⇔ approved / rejected              | `approval_requests_resolution_complete`, `approval_requests_resolution_matches_status`                  |
| Эксперимент не идёт без одобрения запуска                        | `experiments_launch_approval_referenced`                                                                |
| Завершённый эксперимент имеет итог (§2.9)                        | `experiments_result_complete`, `experiments_result_matches_status`                                      |
| Проверка вклада записана ⇔ verified / rejected                   | `contributions_review_complete`, `contributions_review_matches_status`                                  |
| Reward только людям (§2.10)                                      | `rewards_contributor_type_check`                                                                        |
| Одобренный Reward ссылается на одобрение выплаты                 | `rewards_payout_approval_referenced`                                                                    |
| Выплаченный Reward записывает платёж                             | `rewards_payment_complete`, `rewards_payment_matches_status`                                            |
| Неизменяемые записи (§2.2)                                       | триггеры `*_append_only`: `UPDATE` / `DELETE` → `<table>_update_forbidden` / `<table>_delete_forbidden` |
| Строки не удаляются                                              | триггеры `*_no_delete`, `*_no_truncate`                                                                 |
| Новая версия = `version + 1`, автор и время создания не меняются | триггер `*_versioned_update`: `<table>_version_increment`, `<table>_creation_immutable`                 |

Правила, которые БД не проверяет (их проверяет домен): минимальное число элементов в списках id (`evidenceIds ≥ 1`, `painIds ≥ 1`, `result.assetIds ≥ 1`), допустимые переходы статусов, решения только владельца, существование объекта в полиморфной ссылке `subject`, пять разных гипотез.

## Event History (PHASE 03)

| Колонка `events`                                      | Смысл                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `position`                                            | Глобальный порядок записи (identity); по нему журнал читается постранично         |
| `id`, `type`                                          | UUID v7; `<entity>.created` / `<entity>.updated`                                  |
| `aggregate_type`, `aggregate_id`, `aggregate_version` | Сущность и её версия; `UNIQUE` — у каждой версии ровно одно событие               |
| `occurred_at` / `recorded_at`                         | Время изменения по домену / время записи по часам БД                              |
| `actor_type`, `actor_id`                              | Кто изменил: при создании — `createdBy`, при изменении — актор доменного перехода |
| `correlation_id`                                      | Запрос или обновление Telegram, в рамках которого сделано изменение               |
| `payload`                                             | `{ snapshot, previousStatus? }` — снимок сущности в этой версии                   |

Гарантии:

- **Нет изменения без события.** Отложенный constraint trigger `<table>_requires_event` на каждой таблице сущностей проверяет при `COMMIT`, что у вставленной или изменённой строки есть событие того же типа и версии. Иначе транзакция не фиксируется (`ConstraintViolationError`, `kind: 'missing_event'`).
- **История неизменяема.** `UPDATE`, `DELETE` и `TRUNCATE` событий отклоняются; тип события соответствует сущности, `created` — только версия 1.
- **Команды идемпотентны.** В `idempotency_keys` ключ вставляется первым, поэтому одновременный повтор ждёт и видит его; результат записывается один раз (триггер `idempotency_keys_result_once`).

## Стоп-кран (13b)

- `system_controls` — переключатели всей системы; сейчас один, `automation`, с известным id `00000000-0000-7000-8000-000000000001` (`AUTOMATION_CONTROL_ID`). Строку и её событие `system_control.created` (актор `system:migration`) создаёт миграция `0003`, поэтому стоп-кран есть в любой базе.
- `key` уникален; `status` — `running` / `paused`; `reason` задана ровно на паузе (`system_controls_reason_matches_status`).
- Защита та же, что у остальных сущностей с версиями: версия + 1 на каждое изменение, без удаления, событие на каждую версию.
- Миграция расширила домен `entity_type` значением `system_control` (замена CHECK-ограничения; существующие значения остаются допустимыми).

## Доступ (PHASE 04)

- **`principals`** — зарегистрированные личности актора типа `member`, `agent` или `integration`: `actor_type` + `actor_id` (уникальны навсегда), имя, назначение, статус `pending` / `active` / `suspended` / `revoked`.
  - Актор личности не меняется (`principals_actor_immutable`); отозванная личность не меняется (`principals_revoked_final`).
  - Защита истории та же, что у других сущностей с версиями.
- **Нет записи без доступа.** Триггер `events_actor_principal_active` (`BEFORE INSERT ON events`) отклоняет событие от `member` / `agent` / `integration` без активной личности. Каждая запись сущности — это событие (0002), поэтому правило покрывает все записи. Ошибка — `ConstraintViolationError`, `kind: 'access_denied'` (SQLSTATE 42501).
- **Права ролей** БД не хранит: их проверяют репозитории по `@roi-dealer/policies` (`DomainError('permission_denied')`).
- **`access_log`** — только добавление:
  - время (по умолчанию часы БД), канал `telegram` / `database`;
  - актор — `actor_type` пуст для неизвестного отправителя, тогда `actor_id` = `telegram:<id>`;
  - право, решение `allowed` / `denied`, код причины (ровно у отказов), `correlation_id`.
  - Текст сообщений не хранится.
- **Новый вид запроса одобрения** `access_grant` (subject — личность); домен `entity_type` расширен значением `principal`.

## Evidence Engine (PHASE 05)

- **`sources.catalog_key`** — запись каталога `@roi-dealer/evidence`, по которой подключён источник:
  - формат `sources_catalog_key_format`;
  - один источник на запись (`sources_catalog_key_key`).
- **`source_snapshots`** — одна загрузка из источника:
  - время, URL запроса, `content_sha256` ответа, число новых элементов и сохранённых доказательств;
  - сырой ответ не хранится;
  - только добавление, событие обязательно;
  - `(id, source_id)` уникальны, `evidence_count ≤ item_count`, `fetched_at ≤ created_at`.
- **`evidence`:**
  - `snapshot_id` с составным FK `evidence_snapshot_same_source`: снимок того же источника;
  - `external_id` — id у источника, уникален в пределах источника (`evidence_source_external_key`): повторный сбор не создаёт дубликатов;
  - CHECK `evidence_excerpt_without_email`: в цитате нет email. Телефоны и прочие идентификаторы отсекает домен (`containsContactData`) и очистка перед записью.
- Домен `entity_type` расширен значением `source_snapshot`.

## AI Runtime (PHASE 09)

- **`ai_calls`** — одна попытка AI-задачи, только добавление (триггеры `ai_calls_append_only`, `ai_calls_no_truncate`):
  - время (по умолчанию часы БД), задача и версия промпта, назначение `task` / `eval`;
  - провайдер `anthropic` / `openai` / `google`, модель;
  - токены in/out, `cost_micro_usd` — стоимость в миллионных долях доллара, задержка;
  - итог `ok` / `failed` и класс сбоя — ровно у неудачных (`ai_calls_failure_for_failed`);
  - актор и `correlation_id`.
- Промпты, ответы и ключи не хранятся.
- Индексы `(occurred_at)` и `(task, occurred_at)`: суммы за месяц, за день и по задаче — основа бюджета и строк пульта.
- Отчёты evals — сущности `knowledge_assets` с тегами `eval`, `task-…`, `v-…`, `model-…`; расходы за день — `cost_entries` категории `ai`.

## Signals & Pain (PHASE 06)

- **`signal_extractions`** — разбор одного Evidence агентом болей, только добавление (триггеры `signal_extractions_append_only`, `signal_extractions_no_truncate`):
  - Evidence (уникально: `signal_extractions_evidence_once` — каждое разбирается один раз), версия задачи `extract-signal`;
  - итог `signal` / `no_pain` / `rejected` / `failed`; сигнал — ровно у `signal` (`signal_extractions_signal_for_signal`), боль — только вместе с сигналом;
  - актор и `correlation_id`.
- Тексты не хранятся: цитата живёт в `signals.summary` и `pains.description`, взятая из уже очищенного Evidence.
- Строка пишется в той же транзакции, что сигнал и боль.

## Opportunity Engine (PHASE 07)

- **`opportunity_assessments`** — оценка одной версии боли агентом возможностей, только добавление (триггеры `opportunity_assessments_append_only`, `opportunity_assessments_no_truncate`):
  - боль и её версия (уникально: `opportunity_assessments_pain_version_once`), версия задачи `frame-opportunity`;
  - итог `opportunity` / `below_threshold` / `rejected` / `failed`;
  - оценка 0–100 и составляющие (`jsonb`-объект) — ровно у оценённых итогов;
  - возможность — ровно у `opportunity`;
  - актор и `correlation_id`.
- Боль с итогом `opportunity` больше не оценивается; выросшая боль (новая версия) — оценивается заново.
- Тексты не хранятся: подтверждённые цитаты о деньгах — в `opportunities.value_proof`.

## Company Brain (PHASE 08)

- **Индексы поиска** — GIN по выражениям `to_tsvector('english', …)`, без новых колонок:

  | Индекс                        | Текст                                                              |
  | ----------------------------- | ------------------------------------------------------------------ |
  | `pains_search_idx`            | заголовок, описание, аудитория, желаемый результат                 |
  | `opportunities_search_idx`    | заголовок, описание, ICP, проблема, изменение, измеримый результат |
  | `evidence_search_idx`         | цитата `excerpt`                                                   |
  | `knowledge_assets_search_idx` | заголовок, описание, тело                                          |
  | `decisions_search_idx`        | обоснование `rationale`                                            |

- Запросы `database.brain` повторяют эти выражения дословно — иначе PostgreSQL не использует индекс.
- Знания с тегом `eval` (отчёты evals) в поиск и счёт не попадают; заметки владельца — `knowledge_assets` с тегом `owner-note`.

## Agents (PHASE 10)

- **`agent_runs`** — один запуск агента, только добавление (триггеры `agent_runs_append_only`, `agent_runs_no_truncate`):
  - агент (id его актора), начало и конец (`agent_runs_finished_after_start`);
  - итог `done` / `idle` / `no_access` / `stopped` / `failed`, число обработанных;
  - причина остановки `budget` / `unavailable` / `failed` — ровно у `stopped` (`agent_runs_stopped_by_for_stopped`);
  - короткий код сбоя — ровно у `failed` (`agent_runs_failure_for_failed`), без сообщений;
  - индекс `(agent, started_at desc)` для `/agents`.
- **`agent_work`** — работа агента над одной версией объекта, только добавление (триггеры `agent_work_append_only`, `agent_work_no_truncate`):
  - агент, объект `pain` / `opportunity`, его id и версия — уникально (`agent_work_version_once`); ссылка полиморфная, без FK;
  - задача и её версия, итог `done` / `empty` / `rejected` / `failed`;
  - `result` — `jsonb`-объект: id, числа и проверенный поисковый запрос (до 60 символов латиницей), без текстов.
- **Рыночный контекст** — `knowledge_assets` вида `market_data` с тегом `market-context` и `opportunity_id`; в `body` — JSON по `marketContextSchema` (`@roi-dealer/domain`): альтернативы, суммы и покупатели с цитатами и id Evidence.

## Ошибки

`@roi-dealer/database` переводит отказы PostgreSQL в `ConstraintViolationError` с полями `kind` (`unique`, `foreign_key`, `check`, `not_null`, `forbidden_change`, `invalid_value`, `missing_event`, `access_denied`), `constraint`, `table` и `sqlState`. Значения строк в ошибки не попадают.
