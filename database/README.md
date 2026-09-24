# database

PostgreSQL — **authoritative source of truth** бизнес-состояния (конституция §2.1).

| Каталог                               | Назначение                                   | Phase    |
| ------------------------------------- | -------------------------------------------- | -------- |
| [`migrations/`](migrations/README.md) | Версионированные миграции схемы              | PHASE 02 |
| [`seeds/`](seeds/README.md)           | Данные для локальной разработки и тестов     | PHASE 02 |
| [`docs/`](docs/README.md)             | Документация схемы, ER-диаграммы, соглашения | PHASE 02 |

**PHASE 00:** схемы, миграций и драйвера нет. Локальная БД запускается командой `pnpm infra:up` (см. [`infra/README.md`](../infra/README.md)).

Принципы, заложенные на PHASE 02 (из playbook): UUID-идентификаторы (PostgreSQL 18 поддерживает `uuidv7()`), время в UTC, constraints в БД, append-only история (PHASE 03).
