# @roi-dealer/policies

**Статус:** реализован (PHASE 04 — Identity / RBAC / Security; [спецификация](../../docs/phases/04_identity_access.md)). Бюджеты и настраиваемые политики одобрений — PHASE 16.

Роли и права: кто и что может делать в системе (конституция §2.3, §2.11). Чистые функции без I/O; проверку на каждой записи выполняет `@roi-dealer/database`, в пульте — `@roi-dealer/command-center`.

## Export surface

| Экспорт                                       | Назначение                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PERMISSIONS`, `Permission`                   | Список прав: просмотры пульта, исследование, Evidence, запросы и решения, эксперименты, деньги, стоп-кран, доступы |
| `ROLE_PERMISSIONS`                            | Матрица «роль (тип актора) → права»: `owner` — всё; `agent`, `integration`, `system`, `member` — минимум           |
| `ENTITY_WRITE_PERMISSIONS`, `writePermission` | Право, нужное для создания или изменения каждой сущности                                                           |
| `isPermitted`, `assertPermitted`              | Проверка роли; `assertPermitted` — `DomainError('permission_denied')`                                              |
| `decideAccess(actor, permission, principal)`  | Полная проверка: роль + активная личность (`Principal`) для `member` / `agent` / `integration`                     |
| `DENIAL_REASONS`, `DenialReason`              | Коды отказа для журнала доступа                                                                                    |

## Правила

- Решения, одобрения, стоп-кран и управление доступом агенту не выдаются никогда (§2.3).
- Новое право или расширение роли — изменение core policy: только с одобрения владельца (§2.7).
