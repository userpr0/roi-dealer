# @roi-dealer/events

**Статус:** реализован (PHASE 03 — Event History).

Контракты Event History: каждое изменение бизнес-состояния оставляет неизменяемое событие (конституция §2.2). События пишет `@roi-dealer/database` в той же транзакции, что и изменение; этот пакет описывает только их форму.

## Export surface

| Экспорт                                                          | Назначение                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `EVENT_TYPES`, `eventTypeSchema`, `entityEventType`              | `<entity>.created` для 14 сущностей и `<entity>.updated` для 10 изменяемых                        |
| `APPEND_ONLY_ENTITY_TYPES`, `VERSIONED_ENTITY_TYPES`             | Какие сущности только создаются (Evidence, Decision, CostEntry, KnowledgeAsset), а какие меняются |
| `newEventSchema`, `storedEventSchema`, `NewEvent`, `StoredEvent` | Конверт события: id, тип, сущность и версия, время (UTC), актор, `correlationId`, снимок сущности |
| `correlationIdSchema`                                            | Формат `x-correlation-id` и `tg-update-<id>`                                                      |
| `idempotencyKeySchema`                                           | Ключ команды, которая выполняется один раз (`tg-callback-<id>`)                                   |

## Правила

- Событие нельзя переписать или молча удалить; исправление — новое событие (новая версия сущности).
- Тип события соответствует сущности; `created` — всегда версия 1.
- Event History хранится в PostgreSQL (authoritative), не в Temporal history.
