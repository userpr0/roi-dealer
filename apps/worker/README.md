# @roi-dealer/worker

Фоновый процесс ROI Dealer.

- **Всегда:** запуск, heartbeat в логах, graceful shutdown.
- **С `DATABASE_URL` (PHASE 05):** сбор Evidence из источников каталога (`@roi-dealer/evidence`). Без базы worker работает как раньше.

**Что делает worker при запуске и затем по расписанию:**

1. Проверяет стоп-кран. При паузе ничего не делает.
2. Для каждого коннектора создаёт источник по каталогу и запрашивает доступ интеграции у владельца (карточка в `/decisions`).
3. После одобрения забирает новые материалы: не чаще интервала из каталога и не больше лимита элементов. Вычищает персональные данные и сохраняет снимок и Evidence.

Temporal пока не нужен (долгих workflow нет); ADR — при первом.

## Конфигурация

| Переменная                         | По умолчанию                                 |
| ---------------------------------- | -------------------------------------------- |
| `NODE_ENV`                         | `development`                                |
| `LOG_LEVEL`                        | `info` (heartbeat пишется на уровне `debug`) |
| `WORKER_HEARTBEAT_INTERVAL_MS`     | `60000` (минимум 100)                        |
| `DATABASE_URL`                     | не задан → сбор выключен                     |
| `DATABASE_POOL_MAX`                | `5`                                          |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `10`                                         |
| `EVIDENCE_COLLECT_INTERVAL_MS`     | `900000` (15 минут; минимум 100)             |
| `HACKER_NEWS_API_URL`              | официальный API; в тестах — фейковый сервер  |

## Запуск

```bash
pnpm --filter @roi-dealer/worker dev
pnpm --filter @roi-dealer/worker start   # после pnpm build
```

- **SIGTERM / SIGINT:** сначала завершается загрузка, затем закрывается база → `worker stopped` → exit 0.
- **Облако:** [`docs/deploy/worker.md`](../../docs/deploy/worker.md). Образ — `apps/worker/Dockerfile`, миграции — Pre-deploy Command.
