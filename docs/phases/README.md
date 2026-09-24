# Phases

Каждая Phase выполняется отдельно: спецификация → реализация → тесты → Phase Report → **STOP** → approval владельца → следующая Phase.
Спецификация Phase хранится здесь как `NN_short_name.md`, отчёт — `NN_short_name.report.md`.

| Phase | Название                                                      | Спецификация                                           | Статус                                                            |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| 00    | Project Bootstrap                                             | [00_project_bootstrap.md](00_project_bootstrap.md)     | Реализована, ожидает approval владельца                           |
| 01    | Core Domain                                                   | —                                                      | Не начата (только после approval PHASE 00)                        |
| 02    | PostgreSQL Foundation                                         | —                                                      | Не начата                                                         |
| 03    | Event History                                                 | —                                                      | Не начата                                                         |
| 04    | Identity / RBAC / Security                                    | —                                                      | Не начата                                                         |
| 05    | Evidence Engine                                               | —                                                      | Не начата                                                         |
| 06    | Signals & Pain                                                | —                                                      | Не начата                                                         |
| 07    | Opportunity Engine                                            | —                                                      | Не начата                                                         |
| 08    | Company Brain v0.1                                            | —                                                      | Не начата                                                         |
| 09    | AI Runtime                                                    | —                                                      | Не начата                                                         |
| 10    | Agents                                                        | —                                                      | Не начата                                                         |
| 11    | Judges                                                        | —                                                      | Не начата                                                         |
| 12    | Decision Engine                                               | —                                                      | Не начата                                                         |
| 13a   | Telegram owner bot (ранний шаг PHASE 13 по запросу владельца) | [13a_telegram_owner_bot.md](13a_telegram_owner_bot.md) | Реализована ([ADR-0003](../ADR/0003-early-telegram-owner-bot.md)) |
| 13    | Owner Command Center                                          | —                                                      | Не начата (бот-пульт — 13a)                                       |
| 14    | Five Hypothesis Engine                                        | —                                                      | Не начата                                                         |
| 15    | Experiment Engine                                             | —                                                      | Не начата                                                         |
| 16    | Economics                                                     | —                                                      | Не начата                                                         |
| 17    | Reward Engine                                                 | —                                                      | Не начата                                                         |
| 18    | Skill Registry                                                | —                                                      | Не начата                                                         |
| 19    | Media Factory                                                 | —                                                      | Не начата                                                         |
| 20    | CRM / Customer / Outcomes                                     | —                                                      | Не начата                                                         |
| 21    | Solution Factory                                              | —                                                      | Не начата                                                         |
| 22    | Product & Portfolio                                           | —                                                      | Не начата                                                         |
| 23    | Controlled Self-Improvement                                   | —                                                      | Не начата                                                         |

Описание содержания каждой Phase — [`docs/SYSTEM_ARCHITECTURE.md`](../SYSTEM_ARCHITECTURE.md), раздел «7. Полная карта реализации».
