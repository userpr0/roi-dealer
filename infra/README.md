# infra

Инфраструктура.

- **Локальная среда разработки** — `docker/compose.yaml`.
- **Production — Railway.** Запасной план — один сервер Hetzner (D-028, [ADR-0010](../docs/ADR/0010-hosting-hetzner.md)) — `hetzner/`: `compose.yaml`, `Caddyfile`, установка `install.sh` из `cloud-init.yaml`, автообновление `update.sh`, копии `backup.sh`, замена ключа `set-key.sh`. Инструкция владельца — [`docs/deploy/hetzner.md`](../docs/deploy/hetzner.md).

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

Подключение: `postgresql://roi_dealer:roi_dealer_dev_only@localhost:5432/roi_dealer_dev` (`DATABASE_URL` в `.env.example`). Схема создаётся командой `pnpm db:migrate`; integration-тесты создают на этом сервере временные БД и удаляют их после себя.

**Эти учётные данные только для локальной разработки.** Их можно переопределить переменными окружения `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` в shell. В production секреты берутся из Secret Manager / Vault.
