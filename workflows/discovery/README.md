# workflows/discovery — Discovery

**Статус:** Temporal workflows не реализованы. Сбор Evidence (PHASE 05, `packages/evidence`) и разбор болей (PHASE 06, `packages/signals`) — короткие задачи по расписанию в `apps/worker`. Перенос сюда — с ADR на Temporal, когда появятся долгие процессы.
**Реализация:** PHASE 05–06.

## Назначение

Sensory System: сбор данных из Sources → Evidence → Signals → Pain candidates.

## Обязательные ограничения (конституция §2.6)

Каждый workflow обязан иметь: max cost, timeout, retries, max AI calls, allowed external actions, stop conditions.
Workflow не меняет authoritative state в обход backend-проверок (§2.3); Temporal history не является source of truth (§2.1).
