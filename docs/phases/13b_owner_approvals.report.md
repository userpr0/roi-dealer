# 13b REPORT — Одобрения, стоп-кран, журнал и дайджест в пульте

```text
Phase: 13b — Owner Approvals, Kill Switch, Journal and Digest (early step of PHASE 13)
Status: PASS
Date: 2026-09-25
Spec: docs/phases/13b_owner_approvals.md (составлена Claude по решению владельца D-017)
```

## Implemented

- **Пульт в Telegram** (новый пакет `@roi-dealer/command-center`, `apps/bot` только связывает):
  - `/decisions` — карточки ожидающих запросов с неистёкшим сроком (ближайший — первым): вид, сумма, заголовок, описание, срок по Киеву; **✅ Одобрить** / **❌ Отклонить** → вопрос «Одобрить … на $X?» → **Да** / **Отмена**;
  - `/stop [причина]` и `/resume` — подтверждение кнопкой, действует 10 минут;
  - `/journal` и `/history` — кнопки **День** / **Неделя** / **Месяц**: время по Киеву, до 30 последних строк и «…и ещё N раньше»; история — только решения, одобрения, расходы, вехи экспериментов и стоп-кран;
  - `/digest` и ежедневный дайджест в 10:00 `Europe/Kyiv`: ожидающие решения и ближайший срок, изменения за сутки (из них — владельца), расходы за сутки, состояние стоп-крана;
  - `/status` — проверка `database` и состояние стоп-крана (кто и когда остановил, причина).
- **Каждое действие владельца — идемпотентная команда БД:**
  - ключ `tg-callback-<id нажатия>`, `correlation_id` `tg-update-<id обновления>`;
  - решает домен (`resolveApprovalRequest`, `pauseSystem`, `resumeSystem`) с актором `owner` (`telegram:<id>`);
  - новая версия сохраняется с событием;
  - истёкший срок, уже принятое решение и одновременное изменение объясняются в карточке без изменения.
- **Дайджест один раз в день:**
  - команда с ключом `digest-<дата по Киеву>`, сообщение отправляется внутри команды: при неудачной отправке ключ не сохраняется;
  - пропущенный в 10:00 (перезапуск, база недоступна) отправляется до 12:00, повтор каждые 5 минут;
  - время — через `Intl`, переходы на летнее и зимнее время учтены.
- **Стоп-кран — 14-я сущность `SystemControl`** (`@roi-dealer/domain`):
  - ключ `automation`, `running` ⇄ `paused`, причина ровно на паузе;
  - остановить — владелец или система (будущая автопауза), возобновить — только владелец;
  - `assertAutomationRunning` → ошибка домена `automation_paused`; правило «каждая автоматизация проверяет первым шагом» записано в `CLAUDE.md`.
- **`@roi-dealer/telegram`:**
  - inline-кнопки (`callbackButton`, формат `<prefix>:<data>`, не длиннее 64 байт), `editMessageText` (повтор того же содержимого — не ошибка), `answerCallbackQuery`;
  - роутер принимает нажатия только от владельца в личном чате, направляет по префиксу, всегда отвечает на нажатие; устаревшие и чужие кнопки не выполняются;
  - поллер по умолчанию получает `message` и `callback_query`.
- **`@roi-dealer/database`:** `listByStatus(status, { limit })` у изменяемых сущностей; репозиторий `systemControls`.
- **Бот:** `DATABASE_URL` необязателен. Без него всё работает как раньше, а команды пульта отвечают «База данных не подключена»; с ним — health check `database` и закрытие пула при остановке.
- **Миграции в облаке:**
  - Docker-образ бота содержит миграции (`/app/database/migrations`) и раннер;
  - в Railway их применяет **Pre-deploy Command** `node /app/node_modules/@roi-dealer/database/dist/migrate-cli.js` ([инструкция](../deploy/database.md#2-подключить-бота)).
- **Документы:**
  - спецификация и отчёт 13b, решение D-017;
  - инструкции [`deploy/database.md`](../deploy/database.md) и [`deploy/telegram-bot.md`](../deploy/telegram-bot.md);
  - схема БД, README пакетов;
  - `CLAUDE.md`, `SYSTEM_ARCHITECTURE`, таблица применения конституции, `ROADMAP`, `CURRENT_STATE`, план пульта.

## Files created

- `database/migrations/0003_system_control.sql`
- `packages/domain/src/entities/system-control.ts`
- `packages/command-center/` — `package.json`, `tsconfig.json`, `README.md`, `src/{index,command-center,approvals,kill-switch,journal,digest,kyiv-time,texts}.ts`
- `docs/phases/13b_owner_approvals.md`, `docs/phases/13b_owner_approvals.report.md`
- Тесты:
  - `tests/unit/domain/system-control.test.ts`;
  - `tests/unit/command-center/{kyiv-time,texts,digest-scheduler}.test.ts`;
  - `tests/integration/database/system-control.test.ts`;
  - `tests/integration/command-center/command-center.test.ts`.

## Files modified

- `packages/domain/src/{primitives,errors,index}.ts`
- `packages/database/src/{repository,repositories,tables,index}.ts`, `packages/database/README.md`
- `packages/telegram/src/{api-types,client,commands,polling,index}.ts`, `packages/telegram/README.md`, `packages/events/README.md`
- `apps/bot/src/{main,commands,config}.ts`, `apps/bot/{Dockerfile,package.json,tsconfig.json}`
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`
- Тесты:
  - `tests/support/fake-telegram.ts`: нажатия кнопок, `editMessageText`, `answerCallbackQuery`;
  - `tests/integration/bot/process.test.ts`;
  - `tests/integration/database/{migrations,core-loop}.test.ts`;
  - `tests/unit/{bot/commands,domain/primitives,events/contracts}.test.ts`;
  - `tests/unit/telegram/{client,commands,polling}.test.ts`.
- `database/docs/schema.md`, `database/migrations/README.md`
- `docs/{CURRENT_STATE,OWNER_DECISIONS,ROADMAP,SYSTEM_ARCHITECTURE,TECH_STACK,CLAUDE_CONSTITUTION}.md`, `docs/deploy/{database,telegram-bot}.md`, `docs/phases/{README,13_owner_command_center.plan}.md`, `CLAUDE.md`, `README.md`

## Database migrations

- `0003_system_control`:
  - домен `entity_type` расширен значением `system_control` — замена CHECK-ограничения, существующие значения остаются допустимыми;
  - таблица `system_controls` с той же защитой истории, что у других сущностей: версии, без удаления, событие на каждую версию;
  - строка `automation` (известный id) и её событие `system_control.created` от `system:migration`.
- Миграции `0001`, `0002` не изменялись. Деструктивных изменений нет.
- Проверено из собранного Docker-образа: пустая БД → применены три миграции; повторный запуск → `applied: []`, `already_applied: 3`.

## Tests added

78 новых тестов (было 363, стало 441).

- **Unit (+56):**
  - `SystemControl`: пауза владельцем и системой, запрет агенту и участнику, возобновление только владельцем, переходы, причина ровно на паузе;
  - время по Киеву: летнее и зимнее время, переходы 29.03 и 25.10.2026, полночь, смена года;
  - строки журнала, фильтр истории;
  - расписание дайджеста на фальшивых часах: 10:00 каждый день и после перехода на зимнее время, догон после перезапуска в окне и не позже, повтор каждые 5 минут, прекращение после 12:00, остановка;
  - роутер кнопок: только владелец и личный чат, префиксы, устаревшие и некорректные данные, ошибка обработчика, неотвеченное нажатие;
  - клиент: клавиатуры, `editMessageText`, «message is not modified», разбор `callback_query`;
  - команды бота и конфигурация с `DATABASE_URL`.
- **Integration (+22), PostgreSQL 18:**
  - стоп-кран в любой базе после миграции, снимок события совпадает с сущностью; пауза и возобновление с событиями владельца; вторая строка, пауза без причины и удаление отклоняются БД; `listByStatus`;
  - пульт на настоящей БД:
    - одобрение после подтверждения с событием владельца и `correlation_id`;
    - повторная доставка того же нажатия ничего не меняет, новое нажатие по решённому запросу объясняется;
    - отклонение, отмена, истёкший запрос без изменения;
  - стоп-кран: подтверждение, устаревшее подтверждение, `/status`;
  - журнал с временем по Киеву, история без исследовательских данных, ограничение 30 строк;
  - дайджест: содержимое; одна отправка в день; неудачная отправка повторяется;
  - процесс бота с поддельным Telegram:
    - меню из 9 команд;
    - без БД — объяснение;
    - с БД — `/status` с `database` и стоп-краном;
    - `/stop` → нажатие владельца, доставленное дважды → одна пауза, нажатие постороннего игнорируется;
    - одобрение двумя нажатиями;
    - журнал;
    - SIGTERM → exit 0; ни причина, ни токен, ни `DATABASE_URL` не попадают в логи.
- **Исправлен нестабильный тест PHASE 02** «две копии раннера миграций одновременно». Копии могут разделить работу: одна применила `0001`, другая — `0002` и `0003`. Тест сравнивал общий список в порядке массива. Теперь проверяется смысл правила: каждая миграция применена ровно один раз, каждая копия — по порядку файлов. Нестабильность найдена при трёх одновременных прогонах; после исправления — 6 прогонов под нагрузкой без ошибок.

## Test results

Все команды выполнены из корня в порядке CI (PostgreSQL 18.6 в Docker):

```text
pnpm install --frozen-lockfile   ok
pnpm typecheck                   ok
pnpm lint                        ok (0 warnings)
pnpm format:check                ok
pnpm test:unit                   Test Files 29 passed (29) · Tests 329 passed (329)
pnpm build                       ok
pnpm db:migrate                  applied: ["0003_system_control"], already_applied: 2 (локальная БД разработки)
pnpm test:integration            Test Files 11 passed (11) · Tests 112 passed (112)
docker build apps/bot/Dockerfile ok; migrate-cli из образа: 3 миграции, повторно — 0
```

После тестов на сервере не остаётся временных баз `roi_test_*`.

Сборка образа в облачной среде разработки шла через копию Dockerfile с сертификатом прокси этой среды (вне repository): изнутри контейнера сборки нет доступа к npm без него. Файл `apps/bot/Dockerfile` проверен в этой сборке; в CI и Railway он собирается без изменений.

## Security implications

- **Решения только владельца:**
  - роутер пропускает нажатия только с `TELEGRAM_OWNER_USER_ID` в личном чате;
  - домен ещё раз проверяет актора `owner`;
  - в событии записан `telegram:<id>`.
- **Двойное подтверждение** для денег и стоп-крана; повтор нажатия и повторная доставка обновления не выполняют действие дважды (ключ идемпотентности в БД).
- **Данные кнопок** проверяются форматом `^[a-z]{1,8}:[A-Za-z0-9:_-]{0,55}$` и id — UUID; некорректные не выполняются. Логируется только префикс кнопки.
- **Текст сообщений, причины стоп-крана, токен и `DATABASE_URL` не логируются** (проверено тестом процесса). Сообщения отправляются без parse mode, поэтому названия, написанные агентами, не внедрят разметку или ссылки.
- **Автоматизации будущих фаз** обязаны проверять стоп-кран первым шагом (`CLAUDE.md`).

## Cost implications

- Код: $0, новых зависимостей нет (время — встроенный `Intl`).
- Облачная PostgreSQL в Railway — оплата за использование, для этой нагрузки обычно несколько долларов в месяц. Вместе с ботом — в пределах лимита $20/мес (D-007), лимиты Railway уже стоят.

## Known limitations

- **Облачная БД не создана** — это действие владельца ([инструкция](../deploy/database.md)). Живой Telegram API и Railway недоступны из облачной среды разработки. Проверено иначе:
  - бот — на поддельном Bot API;
  - миграции — из собранного образа.

  Поведение Pre-deploy Command при ошибке описано по документации Railway; проверим при первом подключении.

- **Подтверждения `/stop` и `/resume`** хранятся в памяти бота 10 минут: после перезапуска бот просит повторить команду. Решения по карточкам от перезапуска не зависят.
- **Дайджест за 2026-10-25** (переход на зимнее время) проверен на фальшивых часах, а не в реальном времени.
- **Без очереди истечения:** просроченные запросы не показываются и не решаются, но их статус `pending` не меняется на `expired` автоматически. Это сделают фоновые задачи worker, когда они появятся.
- **Журнал за месяц** читает до 10 000 событий периода; при большем объёме сообщает, что прочитана часть.

## Technical debt

- NONE.

## Architecture deviations

- NONE:
  - пульт работает поверх Event History и идемпотентных команд PHASE 03;
  - Telegram — только интерфейс (§2.1);
  - новых зависимостей и сервисов нет;
  - новый пакет `@roi-dealer/command-center` предусмотрен спецификацией 13b («`apps/*` тонкие»).

## Scope decisions

- **Реализовано:** всё из спецификации 13b.
- **Отложено (Feature Kill Gate, §2.15):**
  - кнопки 🔍 «Доисследовать» и ⏸ «Пауза» — к решениям по Opportunity, с Decision Engine (PHASE 12);
  - автопауза при аномальных тратах (D-014 п.10) — когда появятся траты (PHASE 16); стоп-кран её принимает (`pauseSystem` от `system`);
  - staging — после запуска рабочей БД и тестового бота (A5);
  - расписание `pg_dump` — когда в БД появятся данные, которые нельзя быстро восстановить (с PHASE 05);
  - недельный разбор по понедельникам (D-014 п.12) — с метриками экспериментов;
  - Mini App с данными — PHASE 13.

## Business hypothesis enabled by this phase

- **«Владелец управляет системой с телефона»** (Уровень 1 ROADMAP). Решения, стоп-кран, журнал, история и ежедневный дайджест работают из Telegram. Каждое решение оставляет неизменяемый след, повторное нажатие не удвоит трату.
- До Уровня 1 осталось подключить облачную БД — действие владельца на ~10 минут.

## Authoritative data paths verified

- Карточки, журнал, история, дайджест и `/status` читают только PostgreSQL: репозитории и `events.list` с проверкой схемами (§2.13). Суммы расходов считает `summarizeCosts` по записям `CostEntry`.
- Решение из Telegram проверено в БД: статус, `resolution.decidedBy`, событие с актором `owner` и `correlation_id` обновления, отсутствие второго события при повторной доставке.

## Ready for next phase

YES — по порядку playbook PHASE 04 (Identity / RBAC / Security), только после approval владельца. Для Уровня 1 владельцу нужно влить PR, создать облачную PostgreSQL и подключить бота ([инструкция](../deploy/database.md)).
