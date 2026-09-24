# @roi-dealer/rewards

**Статус:** placeholder (PHASE 00). Реализация — PHASE 17 — Reward Engine.

## Назначение

Reward Engine: Contributor → Contribution → Result → Verification → Reward Calculation → Approval → Payable → Paid.

## Правила

- Reward — только за verified contribution.
- Реальные выплаты требуют human approval; payment providers на ранних Phase не подключаются.

## Текущий export surface

- `PACKAGE_NAME` — идентификатор пакета (используется в import-тестах).

Не добавлять логику до одобрения соответствующей Phase владельцем.
