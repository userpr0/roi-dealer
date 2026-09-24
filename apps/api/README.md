# @roi-dealer/api

HTTP API ROI Dealer. **PHASE 00: только `GET /health`**, без бизнес-логики.

| Endpoint                      | Ответ                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `GET /health`, `HEAD /health` | `200 {"status":"ok","service":"api"}`; `503`, если критичная зависимость `down` |
| другие методы на `/health`    | `405` + `Allow: GET, HEAD`                                                      |
| остальное                     | `404 {"error":"not_found"}`                                                     |

Каждый ответ содержит `x-correlation-id` (переданный клиентом валидный id или новый UUID); каждый запрос логируется с ним.

## Конфигурация

| Переменная  | По умолчанию  |                                           |
| ----------- | ------------- | ----------------------------------------- |
| `NODE_ENV`  | `development` | `development \| test \| production`       |
| `LOG_LEVEL` | `info`        | `debug \| info \| warn \| error \| fatal` |
| `API_HOST`  | `127.0.0.1`   | `0.0.0.0` — только внутри контейнера      |
| `API_PORT`  | `3000`        | `0` — случайный свободный порт            |

## Запуск

```bash
pnpm --filter @roi-dealer/api dev     # tsx watch, читает ../../.env при наличии
pnpm --filter @roi-dealer/api start   # node dist/main.js (после pnpm build)
```

## Структура

- `src/config.ts` — Zod-схема конфигурации.
- `src/router.ts` — маршрутизация без зависимости от транспорта (unit-тестируется без сокетов).
- `src/server.ts` — адаптер `node:http`: correlation id, JSON-ответы, access log, обработка ошибок (500 без деталей).
- `src/main.ts` — сборка процесса: config → logger → shutdown → health → server.
