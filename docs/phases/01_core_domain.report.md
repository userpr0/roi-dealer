# PHASE 01 REPORT — Core Domain

```text
Phase: 01 — Core Domain
Status: PASS
Date: 2026-09-24
Spec: docs/phases/01_core_domain.md (составлена Claude по решению владельца D-003)
```

## Implemented

- `@roi-dealer/domain` (≈1 700 строк, только `zod`, без I/O): value objects (branded UUID, UTC `Timestamp`, `Money` в центах USD, `Actor`, `EntityRef`, `Metric`), `defineStateMachine`, `DomainError`, 13 сущностей с Zod-схемами, типами, фабриками и функциями переходов: Source, Evidence, Signal, Pain, Opportunity, Decision, ApprovalRequest, Hypothesis, Experiment, CostEntry, Contribution, Reward, KnowledgeAsset.
- Все 11 правил спецификации: допустимые переходы; решения только владельца; evidence first (Pain → `validated` только с ≥ 2 источниками); решение по Opportunity только через Decision; ровно 5 разных гипотез; stop-loss ≤ бюджета; human gate $20 и обязательные виды одобрений (D-006), одобрение запуска покрывает полный бюджет эксперимента; срок действия одобрений; эксперимент завершается только с активом знаний; Reward только за verified-вклады человека и после payout-одобрения; неизменяемость (новая версия, `version + 1`).
- `@roi-dealer/schemas`: реестр строгих входных контрактов `createInputSchemas`, `approvalDecisionInputSchema`, `contributionReviewInputSchema`, `parseInput` / `InputValidationError`.
- `@roi-dealer/shared`: `uuidv7()` (RFC 9562, совместим с PostgreSQL 18).
- Документы: спецификация PHASE 01, журнал решений владельца `docs/OWNER_DECISIONS.md` (D-001…D-011), план кнопок пульта `docs/phases/13_owner_command_center.plan.md`; ADR-0001 → Accepted.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 21    | 238   | pass      |
| integration | 4     | 24    | pass      |

Новые тесты (96): `uuidv7`; деньги и примитивы; соответствие статусов схем и state machines для всех 9 lifecycle; Source / Evidence / Signal / Pain; Opportunity и Decision (в том числе запрет решений для `agent` и `member`); ApprovalRequest (порог $20 на границе 2000 / 2001 центов, обязательные виды, срок действия, покрытие суммы, subject и id); Five Hypothesis rule (включая дубликаты, отличающиеся регистром и пробелами); Experiment (одобрение полного бюджета, stop, completion только с активом); CostEntry (порог, регулярные платежи, сторно, итоги); цепочка Contribution → Reward; входные контракты (серверные и вложенные лишние поля, отсутствие значений в ошибках).

**Сквозной тест DoD v0.1** проходит весь цикл §11 только через публичный API: Source → Evidence (2 источника) → Signal → Pain → Opportunity → Decision владельца → 5 гипотез из «сырого JSON агента» через `parseInput` → Experiment с MSP и бюджетами → одобрение запуска → расходы (мелкий без одобрения, крупный с одобрением) → KnowledgeAsset → завершение → Contribution → Reward → payout-одобрение.

Сквозной тест нашёл реальную нестыковку: выход `parseInput` (`comment?: string | undefined`) не принимался доменной функцией при `exactOptionalPropertyTypes`. Исправлено: домен принимает выход контрактов напрямую.

## Security implications

- Входные контракты отклоняют поля, назначаемые сервером (защита от mass assignment), и лишние ключи во вложенных объектах.
- Ни `DomainError`, ни `InputValidationError` не содержат значений полей.
- Решения, одобрения, верификация и выплаты закреплены за актором `owner` на уровне домена, а не только интерфейса.

## Cost implications

- $0. Новых runtime-зависимостей нет (`zod` уже использовался).

## Architecture deviations

- NONE. Схемы создания определены рядом с сущностями в `domain`, а `schemas` собирает их в реестр: так исключено дублирование описаний (отражено в спецификации).

## Scope decisions

- **Реализовано:** только сущности, нужные для DoD ROI CORE v0.1 (§11), и ApprovalRequest — основа кнопки «📥 Решения» (D-002).
- **Отложено:** Customer, Deal, Solution, Product, CustomerOutcome, RevenueEntry, Skill Registry, Media — в свои фазы; оценки judges и скоринг (PHASE 07, 11); формулы вознаграждений (PHASE 17); права команды (PHASE 04).

## Business hypothesis enabled by this phase

- Система умеет формально описать «боль → возможность → 5 проверок → эксперимент с бюджетом и stop-loss → итог и актив знаний» с одобрением владельца на каждом денежном шаге. Это прямая основа для первой коммерческой проверки (§11.1) и для кнопок одобрения в пульте.

## Authoritative data paths verified

- Хранения ещё нет (PHASE 02). Проверено детерминированное вычисление итогов расходов в коде (`summarizeCosts`) — основа ответов «сколько потратили» без AI (§7.3).

## Known limitations

- Сущности живут только в памяти; сохранение, optimistic locking по `version` и уникальность — PHASE 02.
- История изменений как события — PHASE 03 (пока `version` и `updatedAt`).
- Роль `member` описана, но права (кто что может) — PHASE 04; сейчас решения принимает только `owner`.

## Technical debt

- Пороговая политика одобрений задаётся константой `DEFAULT_APPROVAL_POLICY`; перенос в настраиваемую политику — PHASE 04 / 16.
- `summarizeCosts` не проверяет, что сторно ссылается на существующую запись (проверка при сохранении — PHASE 02).

## Ready for next phase

**YES** — PHASE 02 (PostgreSQL Foundation) только после approval владельца.
