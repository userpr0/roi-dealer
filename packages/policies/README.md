# @roi-dealer/policies

**Статус:** placeholder (PHASE 00). Реализация — PHASE 04 — Identity / RBAC / Security (далее расширяется).

## Назначение

Политики: permissions (RBAC), budgets, human gates, state-transition rules, evidence requirements.

## Правила

- Любое изменение authoritative state проходит policy check.
- Критические действия (выплаты, большие бюджеты, секреты, core policies) требуют human approval.

## Текущий export surface

- `PACKAGE_NAME` — идентификатор пакета (используется в import-тестах).

Не добавлять логику до одобрения соответствующей Phase владельцем.
