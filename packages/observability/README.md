# @roi-dealer/observability

**Статус:** реализован базовый слой (PHASE 00). Metrics, tracing, alerts — позже (Reliability System).

## Export surface

| Export                                                                | Назначение                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLogger({ service, level?, bindings?, sink?, clock? })`         | Structured JSON logger: одна строка на запись с `timestamp`, `level`, `service`, `message`, `correlation_id?` и полями. `child(bindings)` добавляет поля (например, `correlation_id`) ко всем записям.                                 |
| `serializeLogRecord(record)`                                          | Сериализация без исключений: редактирование чувствительных ключей, `Error` → `{name, message, stack, cause}`, `bigint` → строка, повторные ссылки → `[Circular]`.                                                                      |
| `LOG_LEVELS`, `isLogLevel`, `isSensitiveKey`                          | Уровни `debug < info < warn < error < fatal`; проверка ключей на чувствительность.                                                                                                                                                     |
| `createHealthRegistry({ service, defaultTimeoutMs?, onCheckError? })` | Реестр health checks: `register(check)`, `run()` → `{status, service, checks?}`. Критичный check `down` → сервис `down`; некритичный / `degraded` → `degraded`. Timeout на check (по умолчанию 2 s). Сырые ошибки в отчёт не попадают. |
| `resolveCorrelationId(header)`, `CORRELATION_ID_HEADER`               | Принимает `x-correlation-id` формата `[A-Za-z0-9._:-]{1,128}`, иначе генерирует UUID (защита от log injection).                                                                                                                        |

## Редактирование секретов

Значение заменяется на `[REDACTED]`, если имя ключа (в нижнем регистре, без `-` / `_`) **оканчивается** на:
`password`, `passwd`, `secret`, `token`, `apikey`, `authorization`, `cookie`, `privatekey`, `databaseurl`, `connectionstring`.

Пример: `DB_PASSWORD`, `x-api-key`, `OPENAI_API_KEY`, `refreshToken` редактируются; `token_count`, `max_tokens` — нет.
Это защитная сетка, а не разрешение логировать секреты: секреты не передаются в logger намеренно.

## Правила

- `console.*` в коде запрещён (ESLint `no-console`); весь вывод — через logger.
- Health check новой зависимости регистрируется Phase, которая вводит зависимость; контракт `GET /health` не меняется.
