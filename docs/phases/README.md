# Phases

Каждая Phase выполняется отдельно: спецификация → реализация → тесты → Phase Report → **STOP** → approval владельца → следующая Phase.
Спецификация Phase хранится здесь как `NN_short_name.md`, отчёт — `NN_short_name.report.md`.

| Phase | Название                                                      | Спецификация                                               | Статус                                                                           |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 00    | Project Bootstrap                                             | [00_project_bootstrap.md](00_project_bootstrap.md)         | Принята владельцем (D-001)                                                       |
| 01    | Core Domain                                                   | [01_core_domain.md](01_core_domain.md)                     | Принята владельцем (D-015)                                                       |
| 02    | PostgreSQL Foundation                                         | [02_postgresql_foundation.md](02_postgresql_foundation.md) | Принята владельцем (D-016)                                                       |
| 03    | Event History                                                 | [03_event_history.md](03_event_history.md)                 | Принята владельцем (D-017)                                                       |
| 04    | Identity / RBAC / Security                                    | —                                                          | Не начата                                                                        |
| 05    | Evidence Engine                                               | [требования](05_evidence_engine.plan.md)                   | Не начата (требования D-014)                                                     |
| 06    | Signals & Pain                                                | —                                                          | Не начата                                                                        |
| 07    | Opportunity Engine                                            | —                                                          | Не начата                                                                        |
| 08    | Company Brain v0.1                                            | —                                                          | Не начата                                                                        |
| 09    | AI Runtime                                                    | [требования](09_ai_runtime.plan.md)                        | Не начата (требования D-012, D-014)                                              |
| 10    | Agents                                                        | [требования](09_ai_runtime.plan.md)                        | Не начата (evals — D-014)                                                        |
| 11    | Judges                                                        | —                                                          | Не начата                                                                        |
| 12    | Decision Engine                                               | —                                                          | Не начата                                                                        |
| 13a   | Telegram owner bot (ранний шаг PHASE 13 по запросу владельца) | [13a_telegram_owner_bot.md](13a_telegram_owner_bot.md)     | Реализована ([ADR-0003](../ADR/0003-early-telegram-owner-bot.md))                |
| 13b   | Одобрения, стоп-кран, журнал и дайджест (ранний шаг PHASE 13) | [13b_owner_approvals.md](13b_owner_approvals.md)           | Реализована, ожидает approval владельца ([отчёт](13b_owner_approvals.report.md)) |
| 13    | Owner Command Center                                          | [план кнопок](13_owner_command_center.plan.md)             | Не начата (бот-пульт — 13a; одобрения, стоп-кран, журнал, дайджест — 13b)        |
| 14    | Five Hypothesis Engine                                        | —                                                          | Не начата                                                                        |
| 15    | Experiment Engine                                             | [требования](15_experiment_engine.plan.md)                 | Не начата (требования D-014)                                                     |
| 16    | Economics                                                     | —                                                          | Не начата                                                                        |
| 17    | Reward Engine                                                 | —                                                          | Не начата                                                                        |
| 18    | Skill Registry                                                | —                                                          | Не начата                                                                        |
| 19    | Media Factory                                                 | [требования и план](19_media_factory.plan.md)              | Не начата (требования владельца D-012)                                           |
| 20    | CRM / Customer / Outcomes                                     | —                                                          | Не начата                                                                        |
| 21    | Solution Factory                                              | —                                                          | Не начата                                                                        |
| 22    | Product & Portfolio                                           | —                                                          | Не начата                                                                        |
| 23    | Controlled Self-Improvement                                   | —                                                          | Не начата                                                                        |

Описание содержания каждой Phase — [`docs/SYSTEM_ARCHITECTURE.md`](../SYSTEM_ARCHITECTURE.md), раздел «7. Полная карта реализации».
