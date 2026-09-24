# @roi-dealer/shared

**Статус:** реализован базовый слой (PHASE 00).

## Назначение

Сквозные утилиты **без доменного знания**, общие для всех процессов.

## Export surface

| Export                                          | Назначение                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadConfig(schema, env)`                       | Валидирует переменные окружения Zod-схемой. Пустые строки = «не задано» (срабатывают defaults). Бросает `ConfigValidationError` со списком ключей **без значений**. |
| `nodeEnvSchema`, `portSchema`                   | Переиспользуемые схемы (`development \| test \| production`; порт `0..65535`).                                                                                      |
| `createShutdownManager({ logger, timeoutMs? })` | Регистрирует ресурсы (`register(name, hook)`) и освобождает их один раз в обратном порядке с общим timeout (по умолчанию 10 s).                                     |
| `installProcessHandlers(manager, { logger })`   | SIGTERM / SIGINT → graceful shutdown → exit 0; повторный сигнал → exit 1; `uncaughtException` / `unhandledRejection` → shutdown → exit 1.                           |
| `exitProcess(code)`                             | Завершение с дренажом stdout и страховочным force-exit через 1 s.                                                                                                   |

## Правила

- Не добавлять сюда доменную логику: место домена — `@roi-dealer/domain`.
- Не зависеть от других `@roi-dealer/*` пакетов (logger принимается через структурный интерфейс `LifecycleLogger`).
