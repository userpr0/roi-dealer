# workflows

Durable workflows (Temporal). **PHASE 00: только каталоги и README**, кода нет.

| Каталог                                 | Назначение  | Phase           |
| --------------------------------------- | ----------- | --------------- |
| [`discovery/`](discovery/README.md)     | Discovery   | PHASE 05–06     |
| [`opportunity/`](opportunity/README.md) | Opportunity | PHASE 07, 11–12 |
| [`validation/`](validation/README.md)   | Validation  | PHASE 14–15     |
| [`solution/`](solution/README.md)       | Solution    | PHASE 21        |
| [`reward/`](reward/README.md)           | Reward      | PHASE 17        |
| [`improvement/`](improvement/README.md) | Improvement | PHASE 23        |

Правила для всех workflows:

- PostgreSQL — source of truth; Temporal history — только история исполнения.
- Каждый workflow: max cost, timeout, retries, max AI calls, allowed external actions, stop conditions (§2.6).
- Критические шаги — через human gates (§2.7).
- Будут ли workflows отдельными workspace-пакетами или частью `apps/worker` — решается ADR при подключении Temporal.
