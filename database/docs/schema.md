# Схема базы данных

> Миграции [`0001_core_domain.sql`](../migrations/0001_core_domain.sql) (PHASE 02) и [`0002_event_history.sql`](../migrations/0002_event_history.sql) (PHASE 03). Сущности и правила — [спецификация PHASE 01](../../docs/phases/01_core_domain.md); хранение — [PHASE 02](../../docs/phases/02_postgresql_foundation.md); история — [PHASE 03](../../docs/phases/03_event_history.md).

## Кто за что отвечает

| Слой                   | Отвечает за                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@roi-dealer/domain`   | Поведение: кто может решать, допустимые переходы статусов, пять разных гипотез, покрытие бюджета одобрением, Evidence first |
| PostgreSQL (эта схема) | Структура: типы, перечисления, ссылки, деньги, время, согласованность human gates, неизменяемость истории, версии           |
| `@roi-dealer/database` | Перевод строк в доменные объекты и обратно, проверка прочитанного доменной схемой, optimistic locking, транзакции           |

## Таблицы

```text
sources ─┬─< evidence >──────────────┬─< signal_evidence >── signals ─< pain_signals >── pains
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

## Ошибки

`@roi-dealer/database` переводит отказы PostgreSQL в `ConstraintViolationError` с полями `kind` (`unique`, `foreign_key`, `check`, `not_null`, `forbidden_change`, `invalid_value`, `missing_event`), `constraint`, `table` и `sqlState`. Значения строк в ошибки не попадают.
