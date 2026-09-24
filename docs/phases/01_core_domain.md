# PHASE 01 — Core Domain

> **Основание:** playbook v1.1 §7 («доменные сущности и типизированные схемы»), §2 (конституция), §7.1, §11; решения владельца D-001…D-011 ([`docs/OWNER_DECISIONS.md`](../OWNER_DECISIONS.md)).
> Спецификацию составил Claude по поручению владельца (D-003). **Отчёт:** [01_core_domain.report.md](01_core_domain.report.md).

## Objective

Типизированная доменная модель ROI CORE v0.1: сущности главного цикла, их жизненные циклы и правила, которые backend будет применять перед любым изменением состояния. Модель — чистый TypeScript + Zod, без I/O: база данных (PHASE 02) и события (PHASE 03) строятся поверх неё без перестройки.

## Business purpose

Минимальный набор сущностей, достаточный для Definition of Done ROI CORE v0.1 (§11): Source → Evidence → Signal → Pain → Opportunity → решение владельца → 5 гипотез → план эксперимента с MSP-артефактом и бюджетами → расходы → вклад → подготовка вознаграждения. Плюс запросы на одобрение — основа кнопки «📥 Решения» (D-002, D-010).

## Scope

### Общие value objects (`@roi-dealer/domain`)

| Объект                   | Правило                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Id                       | UUID; для каждой сущности свой branded-тип (`OpportunityId`, …). Генерация — `uuidv7()` из `@roi-dealer/shared` (упорядочены по времени) |
| Timestamp                | ISO-8601 в UTC (`…Z`); время передаётся в доменные функции явно                                                                          |
| Money                    | Целые центы, валюта `USD` (D-005); никаких float                                                                                         |
| Actor                    | Кто действует: `owner`, `member` (команда, D-004), `agent` (AI), `system`, `integration`                                                 |
| EntityRef                | Ссылка `{ type, id }` на любую сущность                                                                                                  |
| Metric                   | `{ name, target, unit, direction: at_least / at_most }`                                                                                  |
| CountryCode, LanguageTag | ISO 3166-1 alpha-2; BCP-47 (`en`, `en-US`)                                                                                               |

Изменяемые сущности содержат `id`, `createdAt`, `createdBy`, `updatedAt`, `version` (для optimistic locking в PHASE 02). Неизменяемые записи (Evidence, Decision, CostEntry, KnowledgeAsset) — только `createdAt`, `createdBy`; исправление — новой записью (§2.2).

### Сущности и жизненные циклы

| Сущность        | Суть                                                                                                                                                                                   | Статусы                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source          | Откуда берутся данные                                                                                                                                                                  | `active ⇄ paused → retired`                                                                                                                                                                                                |
| Evidence        | Неизменяемый факт из источника (цитата, метрика, отзыв…)                                                                                                                               | — (immutable)                                                                                                                                                                                                              |
| Signal          | Наблюдение, подкреплённое ≥ 1 Evidence                                                                                                                                                 | `new → triaged → promoted / dismissed`; `new → dismissed`                                                                                                                                                                  |
| Pain            | Боль аудитории с желаемым результатом                                                                                                                                                  | `candidate → validated / rejected / archived`; `validated → archived`                                                                                                                                                      |
| Opportunity     | Возможность: боли, ICP, рынки, outcome-first ценностное предложение, бизнес-модель                                                                                                     | `draft → under_review → approved / rejected / draft`; `approved → validating / paused / killed`; `validating → scaling / paused / killed`; `paused → validating / killed`; `scaling → paused / killed`; `draft → archived` |
| Decision        | Неизменяемое решение владельца: approve, reject, more_research, pause, kill, scale, improve, pivot                                                                                     | — (immutable)                                                                                                                                                                                                              |
| ApprovalRequest | Human gate: что одобрить, сумма, срок действия                                                                                                                                         | `pending → approved / rejected / expired / cancelled`                                                                                                                                                                      |
| Hypothesis      | Гипотеза проверки (§7.1 Step B): аудитория, GEO, оффер, цена, канал, креатив / демо, CTA, метрика успеха, бюджет, stop-loss, минимум данных, способ проверки; lineage через `parentId` | `proposed → selected / discarded`; `selected → testing / discarded`; `testing → confirmed / refuted / inconclusive`                                                                                                        |
| Experiment      | План и проведение проверки: MSP-артефакт (§7.1 Step C), Experiment Build Budget (Step D), тестовый бюджет, stop-loss, kill criteria, итог                                              | `planned → awaiting_approval → approved → running → stopped / completed`; `stopped → completed`; `planned / awaiting_approval / approved → cancelled`; `awaiting_approval → planned`                                       |
| CostEntry       | Неизменяемая запись расхода (§2.8: ai, api, infrastructure, storage, media, ads, human, refund, vendor, other); сторно — новой записью `reversalOf`                                    | — (immutable)                                                                                                                                                                                                              |
| Contribution    | Вклад участника (человек или AI-агент)                                                                                                                                                 | `recorded → verified / rejected`                                                                                                                                                                                           |
| Reward          | Вознаграждение за проверенные вклады                                                                                                                                                   | `calculated → approved → payable → paid`; `calculated / approved / payable → cancelled`                                                                                                                                    |
| KnowledgeAsset  | Актив, который оставляет цикл (§2.9): knowledge, pattern, failure_pattern, skill, asset, reusable_code, market_data, evidence_summary                                                  | — (immutable; новая версия ссылается на прежнюю через `supersedes`)                                                                                                                                                        |

### Правила (инварианты)

1. **Допустимые переходы.** Любое изменение статуса проходит через state machine сущности; недопустимый переход → `DomainError('invalid_transition')`.
2. **Решает владелец (§2.3, §2.7).** Одобрение / отклонение / kill / scale Opportunity, одобрение эксперимента и ApprovalRequest, верификация вклада и одобрение Reward — только актор `owner`. AI-агент (`agent`) может создавать предложения (Evidence, Signal, Pain, Hypothesis, Experiment в `planned`), но не принимать решения.
3. **Evidence first (§2.5).** Signal требует ≥ 1 Evidence; Pain — ≥ 1 Evidence; перевод Pain в `validated` — Evidence минимум из **2 разных источников**.
4. **Решение применяется только через Decision.** Статус Opportunity после ревью меняется функцией, принимающей Decision владельца по этой Opportunity.
5. **Пять разных гипотез (§7.1 Step B).** Набор для Opportunity — ровно 5 гипотез; никакие две не совпадают по (аудитория, GEO, оффер, цена, канал, способ проверки).
6. **Бюджеты.** Stop-loss ≤ бюджета гипотезы / эксперимента; суммы расходов и бюджетов > 0.
7. **Human gate по деньгам (D-006).** Трата > $20 требует одобрения; регулярные платежи, выплаты людям, покупка активов, запуск эксперимента, production changes, юридические вопросы, доступ к секретам, изменение политик и бюджетов — всегда. CostEntry выше порога без одобренного запроса отклоняется. Одобрение запуска эксперимента должно покрывать его полный бюджет (сборка + AI + тест), чтобы владелец видел всю сумму.
8. **Одобрение имеет срок.** ApprovalRequest нельзя одобрить после `expiresAt`; он переходит в `expired`.
9. **Каждый цикл оставляет актив (§2.9).** Эксперимент нельзя завершить без итога (SCALE / IMPROVE / PIVOT / KILL) и хотя бы одного KnowledgeAsset.
10. **Reward только за проверенный вклад (§2.10).** Reward создаётся только из `verified` вкладов одного и того же человека (`owner` / `member`); одобрение — владельцем со ссылкой на одобренный ApprovalRequest типа `payout`; `paid` — с датой и референсом платежа.
11. **Неизменяемость.** Доменные функции не мутируют объекты: возвращают новую версию (`version + 1`, `updatedAt`).

### Boundary contracts (`@roi-dealer/schemas`)

Строгие (`unknown keys → ошибка`, в том числе во вложенных объектах) схемы входных данных для создания каждой сущности, для решения владельца по ApprovalRequest и для проверки вклада. Схемы создания определены рядом с сущностями в `@roi-dealer/domain`; `@roi-dealer/schemas` собирает их в единый реестр `createInputSchemas` для API, бота, агентов и интеграций. Поля, которые назначает сервер (`id`, `status`, `version`, времена, `createdBy`), во входных данных запрещены. `parseInput` возвращает типизированные данные или `InputValidationError` без значений полей.

### Общие утилиты (`@roi-dealer/shared`)

`uuidv7()` — генерация UUID v7 (совместим с `uuidv7()` в PostgreSQL 18).

## Out of scope

- Хранение в БД, репозитории, миграции (PHASE 02); события и аудит (PHASE 03); роли и права (PHASE 04).
- Customer, Deal, Solution, Product, CustomerOutcome, RevenueEntry, Skill Registry, Media — в своих фазах (16, 18–22).
- Оценки judges и скоринг (PHASE 07, 11), формулы вознаграждений (PHASE 17), AI (PHASE 09).
- Изменения в Telegram-боте.

## Constraints

- Только TypeScript + Zod; `@roi-dealer/domain` без I/O и без зависимостей от других пакетов, кроме `zod`.
- Без новых runtime-зависимостей.
- Время и идентификаторы передаются в доменные функции явно (детерминированные тесты).

## Acceptance criteria

1. Все сущности из таблицы имеют Zod-схему, TypeScript-тип, фабрику создания и (для изменяемых) функции переходов.
2. Все 11 правил реализованы и покрыты unit-тестами, включая негативные случаи.
3. Входные контракты отклоняют лишние и серверные поля и не раскрывают значения в ошибках.
4. Сквозной unit-тест проходит сценарий DoD v0.1 от Source до подготовленного Reward только через публичный API пакетов.
5. typecheck, lint, format, все тесты, build — зелёные; CI зелёный.
