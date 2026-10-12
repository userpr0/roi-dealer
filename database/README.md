# database

PostgreSQL — **authoritative source of truth** бизнес-состояния (конституция §2.1).

| Каталог                               | Назначение                                                  |
| ------------------------------------- | ----------------------------------------------------------- |
| [`migrations/`](migrations/README.md) | Версионированные SQL-миграции (PHASE 02)                    |
| [`docs/`](docs/schema.md)             | Схема: таблицы, связи, какие правила домена проверяет БД    |
| [`seeds/`](seeds/README.md)           | Пока не используются: тесты создают данные фабриками домена |

Код доступа к БД — пакет [`@roi-dealer/database`](../packages/database/README.md): подключение в UTC, раннер миграций, репозитории. Инструменты — [ADR-0005](../docs/ADR/0005-postgresql-driver-and-migrations.md).

```bash
pnpm infra:up      # локальный PostgreSQL 18
pnpm db:migrate    # применить миграции к DATABASE_URL
```

Облачная БД и резервные копии — [`docs/deploy/database.md`](../docs/deploy/database.md).
