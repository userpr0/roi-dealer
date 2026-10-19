# PHASE 13 REPORT — Owner Command Center (остальной пульт)

```text
Phase: 13 — Owner Command Center (остальной пульт; 13a и 13b — раньше)
Status: PASS
Date: 2026-10-19
Spec: docs/phases/13_owner_command_center.md (составлена Claude по D-020; план кнопок 13_owner_command_center.plan.md, D-009, D-014 п.10–12)
ADR: 0008 — данные Mini App через api (Accepted)
Approval mode: D-020 — фазы до Уровня 2 одобрены; следующая — PHASE 17 (Rewards)
```

## Implemented

### Часть A — бот

- **`/stats` (📊):**
  - поток цикла за 30 дней и за всё время: доказательства → сигналы → боли (подтверждённые) → возможности (на решении, в работе) → гипотезы → тесты (запущены, завершены) → клиенты и выручка;
  - метрики D-014 п.11: медиана дней от сигнала до решения, новые знания (без отчётов evals и рыночного контекста), ROI системы и цена проверенной гипотезы за месяц;
  - всё из фиксированных SQL-запросов `database.stats`, с источником. Право — `history.read`.
- **Недельный разбор (D-014 п.12):**
  - по понедельникам в 10:00 Киева вместо дневного дайджеста, тем же планировщиком и ключом `digest-<дата>` — один раз за день, и после перезапуска тоже;
  - решения за неделю по исходам, итоги тестов, расходы месяца против лимитов, новые знания, метрики, затем дневной дайджест;
  - предложение по каждому тесту — правило домена `proposeExperimentOutcome`: метрика достигнута → 🚀 масштабировать; stop-loss или бюджет без метрики → ↪️ сменить подход; срок вышел → 🔧 улучшить; иначе — без предложения;
  - каждое предложение — отдельная карточка с кнопками «итог как предложено» и «другой итог». Они ведут в поток итога PHASE 15 с подтверждением; решает владелец;
  - `/review` — тот же разбор в любой день, текстом.
- **Алерты в дайджесте (⚠️):** «Сбоев агентов за сутки: N → /agents» и «Просроченных тестов: N → /experiments».
- **`/portfolio` (💼):**
  - возможности в работе (`approved`, `validating`, `scaling`, `paused`) со статусом, тестами, тратами, выручкой и клиентами;
  - ⏸ пауза, ▶️ продолжить (снова на проверке), ⛔ закрыть — подтверждение, затем одна идемпотентная команда: `createDecision` от владельца + `applyOpportunityDecision`;
  - кнопки несут версию: устаревшая карточка ничего не меняет;
  - пауза и закрытие отклоняются, пока у возможности есть незавершённые тесты.
- **Отклонение болей в `/pains`:** кнопки «✖️ N» → подтверждение → кандидат становится `rejected`, подтверждённая боль — `archived`. Агент болей пополняет только открытые.

### Часть B — Mini App с данными ([ADR-0008](../ADR/0008-miniapp-data-through-api.md))

- **`verifyInitData`** (`@roi-dealer/telegram`):
  - HMAC-SHA256 по алгоритму Telegram, сравнение в постоянное время;
  - `auth_date` не старше 24 часов;
  - из `user` берётся только `id`;
  - поле `signature` принимается внутри и вне проверяемой строки — обе формы закрыты HMAC.
- **`GET /api/panel`** (`apps/api`):
  - заголовок `Authorization: tma <initData>`;
  - нет подписи, она чужая или устарела → `401`; не владелец → `403` и отказ `not_owner` в журнале доступа, не чаще раза в 10 минут на аккаунт (`createSenderThrottle` — тот же порог, что у бота); без базы или токена → `503`;
  - просмотр владельца — в журнал доступа (канал `telegram`, право `status.read`, корреляция `miniapp-<id>`);
  - CORS только для `MINIAPP_ORIGINS` (по умолчанию `https://userpr0.github.io`); preflight `OPTIONS` — только `GET` и `authorization`;
  - токен, `initData` и заголовок `authorization` не логируются.
- **Снимок пульта** — `panelSnapshot` в `@roi-dealer/command-center`:
  - стоп-кран, очередь решений;
  - экономика месяца из `monthReport`;
  - незавершённые тесты с метрикой, деньгами и днём;
  - статистика цикла;
  - те же функции и подписи, что в боте, поэтому цифры совпадают.
- **Mini App** (`apps/miniapp`):
  - официальный скрипт `telegram-web-app.js`, тема Telegram;
  - одна страница: стоп-кран, «Ждут решения», деньги с полосками лимитов и AI за день, тесты с полосками дней и трат, таблица цикла, метрики;
  - без библиотек графиков;
  - понятные сообщения: адрес API не задан, открыто не из Telegram, подпись не принята, не владелец, не подключено, API не отвечает;
  - только просмотр; адрес `api` — `VITE_API_URL` из переменной репозитория `MINIAPP_API_URL`.
- **Docker-образ `apps/api/Dockerfile`:** `0.0.0.0:8080`, без миграций (их применяют бот и worker).

## Files created

- **Часть A:**
  - `packages/database/src/stats.ts`;
  - `packages/command-center/src/{stats,portfolio}.ts`;
  - `tests/support/cycle.ts`;
  - `tests/unit/command-center/review.test.ts`, `tests/integration/command-center/panel.test.ts`.
- **Часть B:**
  - `packages/telegram/src/init-data.ts`;
  - `packages/command-center/src/panel.ts`;
  - `apps/api/src/panel.ts`, `apps/api/Dockerfile`;
  - `apps/miniapp/src/{panel,telegram}.ts`;
  - `tests/unit/telegram/init-data.test.ts`, `tests/integration/api/panel.test.ts`.
- **Документы:** `docs/phases/13_owner_command_center.md`, этот отчёт, `docs/ADR/0008-miniapp-data-through-api.md`, `docs/deploy/api.md`.

## Files modified

- **Домен:** `proposeExperimentOutcome` в `entities/experiment.ts`.
- **База:** `database.stats`.
- **Пульт:**
  - `/stats`, `/review`, `/portfolio`, кнопки `pf` и `pn`, недельный разбор в планировщике дайджеста;
  - алерты в `digest.ts`;
  - `/pains` с кнопками;
  - `EXPERIMENT_STATUS_LABELS` экспортируются для снимка.
- **`apps/api`:**
  - маршрутизатор с CORS и `/api/panel`;
  - сервер передаёт `origin`, `authorization`, correlation id и отвечает `204` без тела;
  - конфигурация `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_USER_ID`, `MINIAPP_ORIGINS`;
  - зависимости `@roi-dealer/command-center` и `@roi-dealer/telegram`.
- **`apps/miniapp`:** `App.tsx`, `main.tsx`, `styles.css`, `index.html` (скрипт Telegram).
- **`apps/bot`:** команды в `/help` и меню.
- **CI:** `.github/workflows/miniapp-pages.yml` — `VITE_API_URL` из `vars.MINIAPP_API_URL`; `ci.yml` собирает образ api.
- **Тесты:** меню бота в процессе, конфигурация api по умолчанию.
- **Журнал доступа:** порог записей об отказах вынесен в `createSenderThrottle` — им пользуются бот и `api`.
- **Документы:**
  - `CURRENT_STATE.md`, `ROADMAP.md`, `SYSTEM_ARCHITECTURE.md`, `TECH_STACK.md`;
  - `phases/README.md`, `CLAUDE.md`, `.env.example`;
  - `deploy/telegram-bot.md`, ADR-реестр;
  - README `apps/api`, `apps/miniapp`, пульта.

## Database migrations

- Нет. Статистика и снимок — чтение существующих таблиц.

## Tests added

- **Unit (11):**
  - предложения недельного разбора: масштабировать, сменить подход, улучшить, без предложения; понедельник по Киеву;
  - `verifyInitData`: подпись этого бота, совпадение с алгоритмом Telegram, чужой токен и изменённые поля, поле `signature` в двух формах, устаревшие, пустые и неполные данные;
  - маршрут `/api/panel`: CORS только для Mini App, preflight, `405`, `503` без настройки;
  - конфигурация origin: список, отказ пути и `http`.
- **Integration (9, PostgreSQL):**
  - `/stats` из БД: поток, медиана от сигнала до решения, знания без evals;
  - дайджест с алертами; недельный разбор один раз, с предложением и кнопками; кнопка ведёт к подтверждению, ничего не решив;
  - `/portfolio`: отказ при открытом тесте, пауза, продолжение, закрытие, устаревшая карточка, решения от владельца;
  - `/pains`: отклонение с подтверждением, боль уходит из списка, событие от владельца;
  - `GET /api/panel` на настоящем HTTP-сервере: владелец получает снимок, просмотр в журнале доступа; чужой аккаунт — `403` и один отказ в журнале на поток запросов; поддельная, устаревшая, чужого бота и без префикса подпись — `401`, в логах нет токена и `initData`; preflight только для Mini App.

## Test results

| Проверка            | Результат                                                          |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck`    | pass                                                               |
| `pnpm lint`         | pass (0 warnings)                                                  |
| `pnpm format:check` | pass                                                               |
| `pnpm test`         | 73 файла, 779 тестов — pass (unit 526, integration 253); было 759  |
| `pnpm build`        | pass; сборка Mini App содержит только адрес `api`, без секретов    |
| Docker-образы       | бот, worker и api собираются; api отвечает `/health` из контейнера |

## Security implications

- **Данные пульта — только владельцу:** подпись Telegram проверяется на сервере с токеном бота; в сборке Mini App нет секретов, только адрес `api`.
- **Чужие попытки** записываются в журнал доступа и видны в `/access`; поток запросов с одного аккаунта не раздувает журнал — одна запись за 10 минут.
- **Утечка `initData`** даёт только чтение и не дольше суток.
- **CORS** не пускает другие сайты читать ответ в браузере; cookies не используются.
- **Изменения** по-прежнему только кнопками в боте: подтверждение, идемпотентная команда, решение от владельца.
- **Логи:** без токена, `initData`, `authorization` и текстов сообщений.

## Cost implications

- **Часть A — $0.** Запросы статистики — раз на команду и раз в неделю.
- **Часть B — сервис `api` в Railway:** обычно $1–3 в месяц, в пределах лимита инфраструктуры $20 (D-007). Без него всё работает, Mini App пишет, что данные не подключены.

## Known limitations

- **Mini App без автоматического теста отрисовки:** проверены сборка, типы и линтер; страница отрисована в Chromium (ширина телефона) с подставленным ответом `api` — без ошибок в консоли. Логика данных покрыта тестами `api`.
- **Живой Telegram недоступен из облачной среды:** подпись проверена по алгоритму Telegram, записанному в тесте независимо от пакета.
- **День и время недельного разбора** — константы (понедельник, 10:00 Киева). Настройки уведомлений — когда понадобятся (§2.15).
- **Ручное добавление Evidence** — нужен отдельный источник каталога с проверенными правилами (PHASE 05). Заметки — `/note`, расходы — `/cost`.

## Technical debt

- **Типы снимка в Mini App повторяют `PanelSnapshot`:** у Mini App нет зависимостей от серверных пакетов. Изменение снимка — в обоих местах; тест `api` проверяет форму ответа.

## Architecture deviations

- Нет. `api` — по TECH_STACK и SYSTEM_ARCHITECTURE; решение записано в [ADR-0008](../ADR/0008-miniapp-data-through-api.md).

## Scope decisions

- **KILL система не предлагает:** закрытие возможности окончательно. Неудачный тест ведёт к «сменить подход» или «улучшить»; ⛔ остаётся кнопкой «другой итог» и в `/portfolio`.
- **Метрики системы — в `/stats` и недельном разборе, не в ежедневном дайджесте:** медиана и ROI за сутки почти не меняются, а дневной дайджест остаётся коротким. В дайджесте — алерты.
- **Пауза и закрытие при открытых тестах отклоняются:** иначе остались бы тесты, которые тратят деньги на закрытую возможность.
- **«Продолжить» после паузы — решение `improve`:** возможность возвращается на проверку по её жизненному циклу.
- **Подтверждённая боль отклоняется в `archived`:** её жизненный цикл не знает `validated → rejected`.
- **Сбор событий `tracker` со своих страниц** (ADR-0007) — PHASE 19: своих страниц до неё нет (§2.15).
- **Канал журнала доступа — `telegram`:** Mini App открывается из Telegram и подписан им; просмотры отличаются корреляцией `miniapp-<id>`. Новый канал потребовал бы миграции без пользы.

## Business hypothesis enabled by this phase

Около 15 минут в неделю хватает, чтобы видеть систему целиком и решать по готовым предложениям. Пульт в Telegram показывает деньги, тесты и поток цикла на одном экране.

## Authoritative data paths verified

```text
/stats → database.stats (cycle, decisionLatencyDays, newKnowledge) + monthReport → текст с источником
понедельник 10:00 Киева → sendWeeklyReview [digest-<дата>, один раз] → proposeExperimentOutcome → карточка ex:q* → подтверждение → итог PHASE 15
/portfolio → кнопка pf:<p|r|k> → [подтверждение] → database.command: createDecision(owner) + applyOpportunityDecision
/pains ✖️ → [подтверждение] → database.command: changePainStatus(owner) → rejected | archived
Mini App → GET /api/panel (Authorization: tma <initData>) → verifyInitData (HMAC, ≤ 24 ч) → владелец? → access_log → panelSnapshot (БД) → JSON
```

## Ready for next phase

- **Да.** По D-020 следующая — **PHASE 17 (Rewards)**, последняя фаза Уровня 2.
- **Действия владельца после вливания** ([docs/deploy/api.md](../deploy/api.md)):
  1. Railway: сервис `api` — `DATABASE_URL` и ссылки на `TELEGRAM_BOT_TOKEN` и `TELEGRAM_OWNER_USER_ID` бота, публичный домен на порт 8080.
  2. GitHub → Variables: `MINIAPP_API_URL` = адрес `api`, затем **Deploy miniapp → Run workflow**.
  3. Счёт Railway — через `/cost`.
