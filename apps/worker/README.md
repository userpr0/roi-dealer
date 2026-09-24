# @roi-dealer/worker

Фоновый процесс для будущих Temporal workers. **PHASE 00: только lifecycle**: запуск, heartbeat в логах, graceful shutdown. Workflows и задачи не выполняются.

## Конфигурация

| Переменная                     | По умолчанию                                 |
| ------------------------------ | -------------------------------------------- |
| `NODE_ENV`                     | `development`                                |
| `LOG_LEVEL`                    | `info` (heartbeat пишется на уровне `debug`) |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `60000` (минимум 100)                        |

## Запуск

```bash
pnpm --filter @roi-dealer/worker dev
pnpm --filter @roi-dealer/worker start   # после pnpm build
```

SIGTERM / SIGINT → `worker stopped` → exit 0.
