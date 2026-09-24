# infra

Инфраструктура. **PHASE 00: только локальная среда разработки.** Production cloud resources не создаются без отдельного approval владельца.

## Локальная среда — `docker/compose.yaml`

| Сервис           | Статус      | Детали                                                                                                                                     |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres`       | Работает    | PostgreSQL 18 (`postgres:18-alpine`), БД `roi_dealer_dev`, healthcheck `pg_isready`, volume `postgres-data`, порт `127.0.0.1:5432`, TZ=UTC |
| `temporal`       | Placeholder | Добавляется вместе с первым durable workflow (ADR)                                                                                         |
| `object-storage` | Placeholder | S3-compatible (например, MinIO) — при первой потребности в хранении файлов (ADR)                                                           |

```bash
pnpm infra:up      # запустить и дождаться healthy
pnpm infra:logs    # логи
pnpm infra:down    # остановить (данные в volume сохраняются)

# полностью удалить локальные данные:
docker compose -f infra/docker/compose.yaml down --volumes
```

Подключение: `postgresql://roi_dealer:roi_dealer_dev_only@localhost:5432/roi_dealer_dev`

**Эти учётные данные только для локальной разработки.** Их можно переопределить переменными окружения `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` в shell. В production секреты берутся из Secret Manager / Vault.
