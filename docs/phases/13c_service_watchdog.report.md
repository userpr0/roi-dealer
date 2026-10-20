# 13c REPORT — Сторож сервисов и чек-лист запуска

```text
Phase: 13c — Сторож сервисов и чек-лист запуска
Status: PASS
Date: 2026-10-20
Spec: docs/phases/13c_service_watchdog.md (составлена Claude по D-024)
Approval mode: D-024 — надёжность и прозрачность работающей системы
```

## Implemented

- **Отметки сервисов:**
  - бот, `worker` и `api` отмечаются в базе при запуске и раз в минуту (`createServiceHeartbeat`);
  - в отметке — версия и что настроено, только названия и переключатели;
  - версия — `serviceVersion`: `APP_VERSION`, иначе коммит, который развернул Railway, иначе `dev`.
- **Сторож в боте** (`createServiceWatchdog`). Сообщает по одному разу, когда событие началось и когда закончилось:
  - сервис молчит 10 минут;
  - через 20 минут после запуска бота версии сервисов разошлись;
  - провайдер AI отклоняет ключ.

  Каждое событие записывается в журнал `service_incidents` одной транзакцией с сообщением. Сторож работает и при включённом стоп-кране: он только читает и сообщает.

- **Чек-лист запуска в `/status`** (`setupStatus`): `worker`, ключи AI, `api`, форма заявки, кнопка «Пульт», доступы. У каждой строки — ✅ или шаг START.md. Когда всё готово, бот один раз присылает «✅ Всё настроено».
- **Дайджест:** строка «🛠 Сторож за сутки» со списком событий и пометкой «не решено» у открытых.
- **Каталог источников:** GitHub Issues — `rejected` по официальному тексту Acceptable Use Policies §6–7.

## Files created

- `database/migrations/0019_service_watch.sql`.
- `packages/database/src/services.ts`, `packages/command-center/src/watchdog.ts`.
- `tests/integration/command-center/watchdog.test.ts`.
- `docs/phases/13c_service_watchdog.md`, этот отчёт.

## Files modified

- **`@roi-dealer/shared`:** `serviceVersion`, `railwayCommitSchema`.
- **`@roi-dealer/database`:** `database.services` и в транзакции.
- **`@roi-dealer/command-center`:** сторож, чек-лист в `/status`, строка дайджеста, `startWatchdog` / `stopWatchdog`.
- **Приложения:**
  - бот — `WATCHDOG_INTERVAL_MS`, `RAILWAY_GIT_COMMIT_SHA`, своя отметка;
  - `worker` и `api` — `APP_VERSION`, `RAILWAY_GIT_COMMIT_SHA`, отметки.
- **`@roi-dealer/evidence`:** запись GitHub в каталоге.
- **Тесты:** процессы бота, `worker` и `api` (отметки), `/status` команд пульта, каталог, список миграций, версии.
- **Документы:** `CURRENT_STATE.md`, `ROADMAP.md`, `OWNER_DECISIONS.md` (D-024), `phases/README.md`, `CLAUDE.md`, `deploy/START.md`, `deploy/telegram-bot.md`, схема и README миграций, README `command-center`.

## Database migrations

- **`0019_service_watch`:**
  - `service_heartbeats` — строка на сервис; что настроено — JSON до 1 КБ, только переключатели и названия;
  - `service_incidents`:
    - одно открытое событие на вид и предмет (`service_incidents_one_open`);
    - каждое событие — один раз (`service_incidents_once`).
  - Служебные журналы, без событий, как `access_log` и `ai_calls`.

## Tests added

- **Unit (2):** `serviceVersion` и формат коммита Railway.
- **Integration (11 + проверки в 3 тестах процессов):**
  - отметки: одна строка на сервис, значения не проходят, сбой записи только логируется;
  - молчание и восстановление — по одному разу;
  - недоставленное сообщение ничего не открывает и повторяется;
  - версии: после 20 минут, исправление, `dev` не сравнивается;
  - ключ AI: не принят → работает снова;
  - работа при стоп-кране; таймер;
  - строка дайджеста;
  - чек-лист: что осталось → «всё настроено» и сообщение один раз; молчащий сервис в чек-листе;
  - процессы бота, `worker` и `api` пишут свои отметки.

## Test results

| Проверка            | Результат                                                          |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck`    | pass                                                               |
| `pnpm lint`         | pass (0 warnings)                                                  |
| `pnpm format:check` | pass                                                               |
| `pnpm test`         | 85 файлов, 879 тестов — pass (unit 575, integration 304); было 866 |
| `pnpm build`        | pass                                                               |

## Security implications

- **Отметки** не содержат ключей, адресов и почты: схема пропускает только переключатели и короткие названия. Это проверено тестом.
- **Сообщения сторожа** называют переменную, которую нужно исправить, но не её значение.
- **Сторож только читает и пишет свой журнал.** Он не меняет доступы, деньги и решения.

## Cost implications

- **$0:** запись раз в минуту на сервис и чтение раз в минуту в боте. Нагрузка на базу ничтожная.

## Known limitations

- **Остановку самого бота** сторож сообщить не может. Бота перезапускает Railway; если не пришёл дайджест в 10:00, это признак.
- **Расхождение версий** определяется по коммиту Railway. При ручном `APP_VERSION` у одного сервиса, но не у другого, будет ложное сообщение. В Railway `APP_VERSION` задавать не нужно.

## Technical debt

- Нет.

## Architecture deviations

- Нет: новых зависимостей и сервисов нет. Журналы — по образцу `ai_calls`.

## Scope decisions

- **Без внешнего мониторинга** (Uptime Kuma, Better Stack и т. п.): ещё один сервис и аккаунт ради трёх процессов, которые бот и так видит (§2.15).
- **Второй источник Evidence** отложен: официальные условия Stack Exchange и Bluesky недоступны из среды разработки. GitHub проверен и отклонён.

## Ready for next phase

- **После вливания** сторож и чек-лист работают сами.
- **Следующие шаги — по D-024:**
  - второй источник Evidence, после доступа к условиям;
  - этап F — после первых тестов.
