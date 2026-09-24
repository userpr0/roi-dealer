# workflows/validation — Validation

**Статус:** только структура (PHASE 00). Temporal workflows не реализованы.
**Реализация:** PHASE 14–15.

## Назначение

5 Hypotheses → Experiments: бюджеты, метрики, stop-loss, Minimum Sellable Product gate, Early User Crash Test, результаты.

## Обязательные ограничения (конституция §2.6)

Каждый workflow обязан иметь: max cost, timeout, retries, max AI calls, allowed external actions, stop conditions.
Workflow не меняет authoritative state в обход backend-проверок (§2.3); Temporal history не является source of truth (§2.1).
