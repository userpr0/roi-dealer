# @roi-dealer/command-center

**Статус:** реализован (13b — ранний шаг PHASE 13, D-002, D-009, D-010; [спецификация](../../docs/phases/13b_owner_approvals.md)).

Логика пульта владельца в Telegram. `apps/bot` только связывает её с Telegram (`@roi-dealer/telegram`) и PostgreSQL (`@roi-dealer/database`).

## Что делает

| Команда / кнопка                    | Поведение                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/decisions`                        | Карточки ожидающих ApprovalRequest с неистёкшим сроком (ближайший — первым, до 10), кнопки `ap:a:<id>` / `ap:r:<id>`                                                                                  |
| `ap:a` / `ap:r` → `ap:ya` / `ap:yr` | Вопрос с суммой, затем решение: `database.command` с ключом `tg-callback-<id>` и `correlation_id` `tg-update-<id>`; решает домен (`resolveApprovalRequest`, актор `owner`); `ap:c` — назад к карточке |
| `/stop [причина]`, `/resume`        | Подтверждение (`ks:y:<nonce>` / `ks:n:<nonce>`, 10 минут, хранится в памяти), затем `pauseSystem` / `resumeSystem` командой с ключом                                                                  |
| `/journal`, `/history`              | Кнопки `jr:` / `hs:` `day` / `week` / `month`: события периода из `events.list`, время по Киеву, до 30 последних строк; история — только решения, одобрения, расходы, вехи экспериментов, стоп-кран   |
| `/digest`, 10:00 `Europe/Kyiv`      | Ожидающие решения и ближайший срок, изменения за сутки (из них — владельца), расходы за сутки, стоп-кран. По расписанию — один раз в день: команда с ключом `digest-<дата>`; пропущенный — до 12:00   |

Без базы данных (`createCommandCenter({ database: undefined })`) те же команды отвечают, что база не подключена.

## Export surface

| Экспорт                                                             | Назначение                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `createCommandCenter`, `CommandCenter`                              | Команды, обработчики кнопок, строки для `/status`, запуск и остановка дайджеста |
| `ownerActor(telegramUserId)`                                        | Актор `owner` с id `telegram:<id>` (канал и аккаунт — для аудита)               |
| `createKillSwitchFlow`, `killSwitchStatus`, `loadAutomationControl` | Стоп-кран                                                                       |
| `handleApprovalButton`, `sendDecisionCards`, `decidableRequests`    | Одобрения                                                                       |
| `journalText`, `collectEvents`, `isHistoryEvent`, `PERIODS`         | Журнал и история                                                                |
| `buildDigest`, `sendDailyDigest`, `createDigestScheduler`           | Дайджест                                                                        |
| `nextKyivTime`, `kyivDate`, `formatKyivDateTime`, …                 | Время по Киеву через `Intl` (переходы на летнее и зимнее время учтены)          |

## Правила

- Состояние меняет только домен; каждое изменение — идемпотентная команда БД с событием от `owner`.
- Каждая будущая автоматизация и автоматическая трата первым шагом вызывает `assertAutomationRunning` (правило в `CLAUDE.md`).
- Сообщения отправляются без parse mode: названия, написанные агентами, не могут внедрить разметку. Тексты сообщений не логируются.
