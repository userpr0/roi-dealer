# @roi-dealer/ai-runtime

**Статус:** placeholder (PHASE 00). Реализация — PHASE 09 — AI Runtime.

## Назначение

AI Runtime: provider abstraction, Model Router, structured outputs, retries, schema validation, cost tracking. Точка входа: `runTask(taskType, requirements, context)`.

## Правила

- Доменная логика не привязывается к конкретной модели или провайдеру.
- Каждый вызов учитывает стоимость и ограничен бюджетом, timeout, retries, max AI calls.
- На Phase 00 реальные AI providers НЕ подключаются.

## Текущий export surface

- `PACKAGE_NAME` — идентификатор пакета (используется в import-тестах).

Не добавлять логику до одобрения соответствующей Phase владельцем.
