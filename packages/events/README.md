# @roi-dealer/events

**Статус:** placeholder (PHASE 00). Реализация — PHASE 03 — Event History.

## Назначение

Контракты append-only Event History: event envelope, типы событий, idempotency keys, audit metadata.

## Правила

- Событие нельзя переписать или молча удалить; исправление — новое событие.
- Event History хранится в PostgreSQL (authoritative), не в Temporal history.

## Текущий export surface

- `PACKAGE_NAME` — идентификатор пакета (используется в import-тестах).

Не добавлять логику до одобрения соответствующей Phase владельцем.
