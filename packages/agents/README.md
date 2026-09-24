# @roi-dealer/agents

**Статус:** placeholder (PHASE 00). Реализация — PHASE 10 — Agents.

## Назначение

AI-агенты: Research, Pain, Market Context, Opportunity, Knowledge.

## Правила

- Агент возвращает предложение / structured result и НЕ меняет authoritative business state напрямую.
- Агенты вызывают AI только через `@roi-dealer/ai-runtime` (`runTask`), без привязки к провайдеру.

## Текущий export surface

- `PACKAGE_NAME` — идентификатор пакета (используется в import-тестах).

Не добавлять логику до одобрения соответствующей Phase владельцем.
