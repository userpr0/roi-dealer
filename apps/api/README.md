# @roi-dealer/api

HTTP API ROI Dealer: `GET /health` (PHASE 00, база — PHASE 02) и данные Mini App (PHASE 13, [ADR-0008](../../docs/ADR/0008-miniapp-data-through-api.md)). Только чтение; логика снимка — в `@roi-dealer/command-center`.

| Endpoint                      | Ответ                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /health`, `HEAD /health` | `200 {"status":"ok","service":"api"}`; `503`, если критичная зависимость `down`                            |
| другие методы на `/health`    | `405` + `Allow: GET, HEAD`                                                                                 |
| `GET /api/panel`              | снимок пульта владельцу; `401` без верной свежей подписи Telegram, `403` не владельцу, `503` без настройки |
| `OPTIONS /api/panel`          | preflight: `204` только для origin из `MINIAPP_ORIGINS`, иначе `403`                                       |
| остальное                     | `404 {"error":"not_found"}`                                                                                |

Каждый ответ содержит `x-correlation-id` (переданный клиентом валидный id или новый UUID); каждый запрос логируется с ним.

## `GET /api/panel`

- **Заголовок:** `Authorization: tma <initData>` — строка, которую Telegram передаёт Mini App (`window.Telegram.WebApp.initData`).
- **Проверка:** `verifyInitData` из `@roi-dealer/telegram` — HMAC с токеном бота, `auth_date` не старше суток, из `user` берётся только `id`.
- **Журнал доступа:** просмотр владельца — `allowed`; чужой аккаунт Telegram — `denied` с `not_owner`, не чаще раза в 10 минут на аккаунт (`createSenderThrottle`, как в боте). Канал `telegram`, право `status.read`, корреляция `miniapp-<id>`.
- **CORS:** `access-control-allow-origin` только для origin из `MINIAPP_ORIGINS`.
- **В логи не попадают** токен, `initData` и заголовок `authorization`.

## Конфигурация

| Переменная               | По умолчанию                |                                                             |
| ------------------------ | --------------------------- | ----------------------------------------------------------- |
| `NODE_ENV`               | `development`               | `development \| test \| production`                         |
| `LOG_LEVEL`              | `info`                      | `debug \| info \| warn \| error \| fatal`                   |
| `API_HOST`               | `127.0.0.1`                 | `0.0.0.0` — только внутри контейнера (в образе так и стоит) |
| `API_PORT`               | `3000`                      | `0` — случайный свободный порт; в образе `8080`             |
| `DATABASE_URL`           | —                           | с ней `/health` проверяет базу                              |
| `TELEGRAM_BOT_TOKEN`     | —                           | токен бота, только для проверки подписи Mini App            |
| `TELEGRAM_OWNER_USER_ID` | —                           | id владельца в Telegram                                     |
| `MINIAPP_ORIGINS`        | `https://userpr0.github.io` | origin Mini App через запятую, `https://` без пути          |

`/api/panel` включается, когда заданы `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` и `TELEGRAM_OWNER_USER_ID`.

## Запуск

```bash
pnpm --filter @roi-dealer/api dev     # tsx watch, читает ../../.env при наличии
pnpm --filter @roi-dealer/api start   # node dist/main.js (после pnpm build)
docker build -f apps/api/Dockerfile -t roi-dealer-api .
```

Развёртывание в Railway — [docs/deploy/api.md](../../docs/deploy/api.md).

## Структура

- `src/config.ts` — Zod-схема конфигурации.
- `src/router.ts` — маршрутизация без зависимости от транспорта (unit-тестируется без сокетов), CORS `/api/panel`.
- `src/panel.ts` — `GET /api/panel`: подпись Telegram → журнал доступа → `panelSnapshot`.
- `src/server.ts` — адаптер `node:http`: correlation id, JSON-ответы, access log, обработка ошибок (500 без деталей).
- `src/main.ts` — сборка процесса: config → logger → shutdown → health → panel → server.
