# Current State

```text
Current Phase: 19a — Media Factory (минимум)
Phase Status: PASS
Completed: 00 — Project Bootstrap (PASS), 01 — Core Domain (PASS, accepted D-015), 02 — PostgreSQL Foundation (PASS, accepted D-016), 03 — Event History (PASS, accepted D-017), 13a — Telegram Owner Bot (PASS, owner-approved early step), 13b — Owner Approvals and Kill Switch (PASS, accepted D-018), 04 — Identity / RBAC / Security (PASS, accepted D-019), 05 — Evidence Engine (PASS, PR awaiting merge), 09 — AI Runtime (PASS, PR awaiting merge), 06 — Signals & Pain (PASS, PR awaiting merge), 07 — Opportunity Engine (PASS, PR awaiting merge), 08 — Company Brain v0.1 (PASS, PR awaiting merge), 10 — Agents (PASS, PR awaiting merge), 11 — Judges (PASS, PR awaiting merge), 12 — Decision Engine (PASS, PR awaiting merge), 14 — Five Hypothesis Engine (PASS, PR awaiting merge), 15 — Experiment Engine (PASS, PR awaiting merge), 16 — Economics (PASS, PR awaiting merge), 13 — Owner Command Center (PASS, PR awaiting merge), 17 — Reward Engine (PASS, PR awaiting merge), 19a — Media Factory (PASS, PR awaiting merge)
Level: 1 reached (2026-10-18: bot + cloud PostgreSQL in Railway); Level 2 built — all D-020 phases PASS, awaiting merge and owner setup; Level 3 in progress (D-022)
Approval mode: D-020 — all phases up to full Level 2 approved; order 05 → 09 → 06 → 07 → 08 → 10 → 11 → 12 → 14 → 15 → 16 → 13 → 17; D-021 — three AI providers, daily AI budget; D-022 — Level 3 approved, order 19a → 21 → 20 → 20b
Playbook: v1.1
Updated: 2026-10-19
```

Отчёты: [PHASE 00](phases/00_project_bootstrap.report.md), [13a — Telegram Owner Bot](phases/13a_telegram_owner_bot.report.md), [PHASE 01 — Core Domain](phases/01_core_domain.report.md), [PHASE 02 — PostgreSQL Foundation](phases/02_postgresql_foundation.report.md), [PHASE 03 — Event History](phases/03_event_history.report.md), [13b — Одобрения и стоп-кран](phases/13b_owner_approvals.report.md), [PHASE 04 — Identity / RBAC / Security](phases/04_identity_access.report.md), [PHASE 05 — Evidence Engine](phases/05_evidence_engine.report.md), [PHASE 09 — AI Runtime](phases/09_ai_runtime.report.md), [PHASE 06 — Signals & Pain](phases/06_signals_pain.report.md), [PHASE 07 — Opportunity Engine](phases/07_opportunity_engine.report.md), [PHASE 08 — Company Brain v0.1](phases/08_company_brain.report.md), [PHASE 10 — Agents](phases/10_agents.report.md), [PHASE 11 — Judges](phases/11_judges.report.md), [PHASE 12 — Decision Engine](phases/12_decision_engine.report.md), [PHASE 14 — Five Hypothesis Engine](phases/14_five_hypotheses.report.md), [PHASE 15 — Experiment Engine](phases/15_experiment_engine.report.md), [PHASE 16 — Economics](phases/16_economics.report.md), [PHASE 13 — остальной пульт](phases/13_owner_command_center.report.md), [PHASE 17 — Reward Engine](phases/17_rewards.report.md), [PHASE 19a — Media Factory](phases/19a_media_factory.report.md)

Решения владельца: [`docs/OWNER_DECISIONS.md`](OWNER_DECISIONS.md) · План до рабочего состояния: [`docs/ROADMAP.md`](ROADMAP.md)

## Implemented

- pnpm monorepo (`apps/*`, `packages/*`), воспроизводимая установка (`pnpm install --frozen-lockfile`).
- TypeScript 6.0 strict + project references (`tsc -b`), ESLint 10 (type-aware, `no-console`), Prettier.
- Vitest: 77 test files, 810 tests (545 unit, 265 integration); integration-тесты работают с настоящим PostgreSQL 18.
- Config validation (Zod), structured JSON logging с редактированием секретов, correlation id, health registry, graceful shutdown.
- `GET /health` → `{"status":"ok","service":"api"}`; при заданном `DATABASE_URL` — ещё проверка `database` (недоступна → HTTP 503); `GET /api/panel` — данные Mini App владельцу по подписи Telegram (PHASE 13).
- Docker Compose: PostgreSQL 18 (healthcheck, volume, loopback-only, UTC).
- GitHub Actions CI: install → typecheck → lint → format check → unit tests → build → миграции → integration tests (сервис PostgreSQL 18) → compose validation; сборка Docker-образов бота, worker и api. Первый запуск на GitHub — success ([run #1](https://github.com/userpr0/roi-dealer/actions/runs/36001981452)).
- Документация: конституция, архитектура, стек, протокол, ADR (ADR-0001…0008 Accepted), решения владельца (D-001…D-022), план кнопок пульта, phases, runbooks, playbook v1.1.
- **PHASE 01 — Core Domain:** `@roi-dealer/domain` — 13 сущностей цикла ROI CORE v0.1 (Source → … → Reward, ApprovalRequest), value objects (UUID, UTC, USD в центах, Actor), state machines и 11 правил (решения только владельца, evidence first, 5 разных гипотез, human gate $20, актив по итогам эксперимента, Reward только за проверенный вклад); `@roi-dealer/schemas` — строгие входные контракты; `uuidv7()` в `@roi-dealer/shared`.
- **PHASE 02 — PostgreSQL Foundation:** пакет `@roi-dealer/database` (postgres.js, [ADR-0005](ADR/0005-postgresql-driver-and-migrations.md)) — пул в UTC, раннер SQL-миграций (SHA-256, блокировка, транзакция на файл), 13 репозиториев с optimistic locking и проверкой прочитанного доменной схемой, транзакции, ошибки без значений; миграция `0001_core_domain` — таблицы 13 сущностей, связи, CHECK / FK для денег, времени и human gates, триггеры защиты истории ([схема](../database/docs/schema.md)); `pnpm db:migrate`; инструкция для облачной БД [`docs/deploy/database.md`](deploy/database.md).
- **PHASE 03 — Event History:** пакет `@roi-dealer/events` (22 типа событий `<entity>.created` / `.updated`, конверт, correlation id, ключи идемпотентности); миграция `0002_event_history` — таблица `events` (append-only, одна версия — одно событие), проверка при `COMMIT` «нет изменения сущности без события», `idempotency_keys`; репозитории пишут событие на каждую запись в той же транзакции (`update(entity, actor)` с блокировкой строки); `database.events.history` / `list` (журнал за период, постранично); `database.transaction(work, { correlationId })`; `database.command({ idempotencyKey })` — ровно один раз, в том числе при одновременных повторах.
- **13b — одобрения, стоп-кран, журнал и дайджест (D-002, D-009, D-010, D-017):** пакет `@roi-dealer/command-center`; в боте — `/decisions` (карточки ✅ / ❌ → вопрос с суммой → **Да**), `/stop [причина]` и `/resume` с подтверждением на 10 минут, `/journal` и `/history` за день / неделю / месяц по Киеву, `/digest` и ежедневный дайджест в 10:00 `Europe/Kyiv` (один раз в день, в том числе после перезапуска). Каждое действие — идемпотентная команда БД (`tg-callback-<id>`) с событием от `owner` (`telegram:<id>`). Новая сущность `SystemControl` и правило `assertAutomationRunning`; миграция `0003_system_control`; `listByStatus` в репозиториях; inline-кнопки и `callback_query` в `@roi-dealer/telegram`. `DATABASE_URL` у бота необязателен; Docker-образ содержит миграции, в Railway их применяет Pre-deploy Command.
- **PHASE 04 — Identity / RBAC / Security (D-018):**
  - `@roi-dealer/policies` — роли (тип актора) и права с минимальными полномочиями; агенту недоступны решения, одобрения, стоп-кран и доступы; интеграции — только Evidence и расходы.
  - 15-я сущность `Principal` — личность агента, интеграции или участника: `pending` → `active` ⇄ `suspended` → `revoked`; выдаёт, приостанавливает и отзывает только владелец.
  - Каждая запись репозитория проверяет право роли и активную личность; триггер БД не пропускает событие без активной личности.
  - Доступ новой интеграции или агента — `requestAccess` → карточка `access_grant` в `/decisions`.
  - `/access` — приостановить, вернуть, отозвать с подтверждением.
  - Журнал доступа `access_log`: просмотры пульта, отказы записи (даже при откате), попытки посторонних (раз в 10 минут на отправителя, без текста); строка об отказах в дайджесте.
  - Миграция `0004_identity_access`.
- **PHASE 05 — Evidence Engine (D-019):**
  - **Пакет `@roi-dealer/evidence`:**
    - каталог источников с проверенными условиями: 7 записей, `allowed` только у Hacker News; Reddit требует договора, CFPB снимает тексты жалоб, остальные ждут проверки;
    - коннектор Hacker News (Ask HN, официальный API);
    - очистка персональных данных: email, телефоны, профили, ники, SSN, карты, IP; автор не читается;
    - сбор: стоп-кран → каталог → доступ интеграции → загрузка → очистка → одна транзакция;
    - подключение источника с запросом доступа в `/decisions`;
    - расписание в worker.
  - **Домен:** 16-я сущность `SourceSnapshot` (загрузка: время, запрос, SHA-256, без сырого ответа); у `Source` — `catalogKey`; у `Evidence` — `snapshotId`, `externalId` и правило «нет email и телефонов».
  - **Миграция `0005_evidence_engine`:** `source_snapshots`, `catalog_key`, составной FK «снимок того же источника», уникальность элемента в источнике, CHECK без email.
  - **Worker:** сбор по расписанию (`DATABASE_URL`, без Temporal), Docker-образ `apps/worker/Dockerfile` с миграциями; CI собирает оба образа.
  - **Пульт:** `ensureAccessRequest` (повтор истёкшего запроса); строка Evidence в дайджесте; журнал сворачивает пачку событий одного запроса в «×N».
  - **Документы:** [инструкция worker](deploy/worker.md), [runbook запроса на удаление данных](runbooks/data-deletion-request.md).
- **PHASE 09 — AI Runtime (D-020, D-021, [ADR-0006](ADR/0006-ai-providers-and-runtime.md)):**
  - **`runTask`** в `@roi-dealer/ai-runtime` — единственная точка вызова AI. Порядок проверок: вход по схеме → стоп-кран → модели с проходным отчётом evals → бюджет → вызов → ответ по схеме → журнал. При сбое — модель другого провайдера.
  - **Провайдеры:** Claude, GPT и Gemini через официальные SDK, без автоповторов SDK.
  - **Порядок моделей задают evals:** массовая работа — самая дешёвая из прошедших эталон, суждения — самая точная.
  - **Бюджет:**
    - $50 в месяц;
    - квота дня — остаток месяца на оставшиеся дни, не больше $20;
    - у каждого процесса своя доля дня, у evals — 20 %.
  - **Evals:** эталонный набор от 20 примеров; отчёт — `KnowledgeAsset`; модель без проходного отчёта не используется.
  - **Миграция `0006_ai_runtime`:** журнал `ai_calls`; ежедневная `CostEntry` категории `ai`.
  - **Первая задача `redact-names`:** AI находит имена людей, код заменяет их на `[name]` в новых Evidence.
  - **Worker:** ключи провайдеров, обслуживание раз в час.
  - **Пульт:** строка AI в `/status` и в дайджесте.
- **PHASE 06 — Signals & Pain (D-020):**
  - **Агент `pain-analyst`** (`@roi-dealer/signals`) разбирает каждое новое Evidence один раз. Доступ выдаёт владелец в `/decisions`; стоп-кран — первым шагом.
  - **AI-задача `extract-signal`** находит боль, формулирует её одним утверждением и приводит дословную цитату. Код проверяет, что цитата действительно есть в тексте.
  - **Группировка:** сначала словесное сходство (бесплатно), затем AI-задача `match-pain` по ≤ 10 ближайшим. Похожие сигналы собираются в одного кандидата `Pain`; частота и тяжесть растут; два источника → `validated`.
  - **Домен:** `addSignalToPain`.
  - **Миграция `0007_signals_pain`:** журнал `signal_extractions`.
  - **Пульт:** `/pains`, строка в дайджесте.
  - **Бюджет:** доли дня 15 % + 5 %.
- **PHASE 07 — Opportunity Engine (D-020):**
  - **Агент `opportunity-analyst`** (`@roi-dealer/opportunities`) берёт боли с ≥ 2 сигналами. Доступ — в `/decisions`, стоп-кран — первым шагом.
  - **AI-задача `frame-opportunity`** формулирует возможность по §2.17 и отмечает признаки: покупатель, повторяемость, срочность, ручная работа, цитаты о деньгах.
  - **Код** засчитывает только найденные цитаты и считает оценку 0–100: частота, тяжесть, источники, готовность платить, рынки D-008, покупатель.
  - **Business Model Router** выбирает первую гипотезу монетизации.
  - **Черновики** создаются при оценке ≥ 55.
  - **Миграция `0008_opportunity_engine`:** журнал `opportunity_assessments`.
  - **Пульт:** `/opportunities`, строка в дайджесте.
- **PHASE 08 — Company Brain v0.1 (D-020):**
  - **Поиск** (`@roi-dealer/brain`, `database.brain`): полнотекстовый поиск PostgreSQL по болям, возможностям, Evidence, знаниям и решениям. Нет записей со всеми словами — показываются похожие; на кириллицу — подсказка, что данные английские.
  - **`/ask`:** правила распознают вопрос о расходах (сторно вычитаются), AI, количествах и новом за период. Ответ — числа из БД с источником, без AI; прочие вопросы — поиск.
  - **`/note`:** знание владельца — после подтверждения, идемпотентной командой.
  - **`similarCases`** — похожие прошлые случаи для судей и карточки решения.
  - **Миграция `0009_company_brain`:** GIN-индексы поиска, данные не меняются.
- **PHASE 10 — Agents (D-020):**
  - **Общие правила** (`@roi-dealer/agents`): `runAgent` — стоп-кран → запрос доступа → работа → журнал `agent_runs`; один планировщик на всех агентов. Агенты болей и возможностей перешли на него.
  - **Агент исследований:** для болей с меньше чем 3 сигналами AI предлагает поисковый запрос (`research-query`), код оставляет только слова; посты Ask HN приходят через HN Search общим путём сбора — с каталогом, доступом HN и очисткой.
  - **Агент рыночного контекста:** для черновиков возможностей AI собирает альтернативы, суммы и покупателей (`market-context`); код оставляет только пункты с цитатой из названного Evidence и читает суммы из цитат. Результат — знание `market_data` для судей.
  - **Миграция `0010_agents`:** журналы `agent_runs` и `agent_work`.
  - **Пульт:** `/agents`; строка «Рынок» в `/opportunities`.
  - **Бюджет:** доли дня 3 % и 7 %; распланировано 70 % дня, 30 % — судьям.
- **PHASE 11 — Judges (D-020):**
  - **Шесть судей** (`@roi-dealer/judges`): рынок, боль и ценность, экономика, сборка, риск, повторное использование — каждый критерий отдельным вызовом `judge-opportunity` (уровень `strong`, 24 эталона, доля дня 30 %).
  - **Код проверяет ответ:** балл 1–5, обоснование, существующие ссылки; без ссылок на Evidence рынок, боль и экономика — не выше 2.
  - **Агент судей** ждёт рыночный контекст версии (или сутки), продолжает после остановки по квоте, полностью оценённый черновик переводит в `under_review`.
  - **Итог 0–100 и слабые места** считает домен (`judgePanel`).
  - **Миграция `0011_judges`:** журнал `opportunity_judgements`.
  - **Сильные модели** трёх провайдеров: Claude Opus 5.5, GPT-5.5, Gemini 3.1 Pro.
  - **Пульт:** строка судей в `/opportunities`.
- **PHASE 12 — Decision Engine (D-020):**
  - **Карточка возможности** в Telegram — всё из БД: клиент, проблема → изменение → результат, модель, оценка, судьи и слабые места, рынок, цитаты со ссылками, рекомендация системы.
  - **Рекомендация** — правила домена (`recommendOpportunity`), не AI.
  - **✅ Проверять / ❌ Не брать / 🔍 Доисследовать:** подтверждение, затем одна идемпотентная команда — `Decision` от владельца и переход возможности; устаревшая карточка ничего не меняет.
  - **Карточки приходят сами:** каждая версия один раз, стоп-кран останавливает; `/decisions` и дайджест показывают очередь.
  - **Урок решения** — обоснование в Company Brain; судьи видят его как похожий случай. После «доисследовать» судьи ждут новых сигналов.
  - **Готово «система сама предлагает».**
- **PHASE 14 — Five Hypothesis Engine (D-020):**
  - **Агент гипотез** для каждой одобренной возможности предлагает пять гипотез §7.1 B (`design-hypotheses`, bulk, доля дня 5 %).
  - **Код проверяет:**
    - поля: рынок из возможности, цена, бюджет ≤ $100, stop-loss ≤ бюджета;
    - набор: пять разных тестов, ≥ 3 способов, ≥ 2 цен, демо или concierge, сумма ≤ $300.
    - При нарушениях — одна попытка исправить.
  - **Хранение:** пять `Hypothesis` в статусе `proposed` одной транзакцией.
  - **Пульт:** `/hypotheses`; уведомление «гипотезы готовы» — один раз на возможность.
  - **Бюджет:** судьи 25 %, гипотезы 5 %.
- **PHASE 15 — Experiment Engine (D-020, D-014 п.8–9, [ADR-0007](ADR/0007-experiment-funnel-in-postgresql.md)):**
  - **Единая воронка:** девять шагов, события в `experiment_events` (миграция `0012`); метрика успеха — шаг или доля, считает код (`design-hypotheses` v2).
  - **Тест кнопками:**
    - «🧪 N» в `/hypotheses` → план в коде;
    - чек-лист честной проверки → запрос `experiment_launch` в `/decisions`;
    - ▶️ старт, `/funnel` — цифры и траты, ⏹ стоп, 🏁 итог.
  - **Без чек-листа не стартует** — домен и CHECK в базе. Траты — только в пределах одобренного запуска; stop-loss останавливает сам.
  - **Итог:** знание в Company Brain, решение владельца, статус гипотезы по данным; «масштабировать» и «закрыть» меняют возможность.
- **PHASE 16 — Economics (D-020, D-007, D-014 п.10–11):**
  - **Журнал выручки** `revenue_entries` (миграция `0013`): оплаты и предзаказы с числом клиентов; возвраты — расходы `refund`, не больше полученного.
  - **`/funnel`:** `оплаты 3 выручка 36`, `вернули 12`. На карточке теста — выручка, CAC, ROI.
  - **`/cost`:** расходы вне тестов; выше $20 — с одобрением владельца (D-006).
  - **`/economics`:** месяц против лимитов ($20 инфраструктура, $50 AI), тесты, выручка, ROI системы, стоимость проверенной гипотезы.
  - **Автопауза:** автоматика потратила за день ≥ 2× среднего (не меньше $5) → стоп-кран от `system:spend-guard` и одно сообщение владельцу.
- **PHASE 13 — остальной пульт (D-020, D-014 п.11–12, [ADR-0008](ADR/0008-miniapp-data-through-api.md)):**
  - **`/stats`:** поток цикла за 30 дней и за всё время; время от сигнала до решения, новые знания, ROI системы, цена проверенной гипотезы — из БД (`database.stats`), с источником.
  - **Недельный разбор:** по понедельникам в 10:00 Киева вместо дайджеста; предложение по каждому тесту — правило домена `proposeExperimentOutcome`, кнопки ведут в итог PHASE 15 с подтверждением; `/review` — в любой день.
  - **Алерты в дайджесте:** сбои агентов, просроченные тесты.
  - **`/portfolio`:** ⏸ пауза, ▶️ продолжить, ⛔ закрыть — решения владельца с подтверждением; при незавершённых тестах пауза и закрытие отклоняются.
  - **`/pains`:** отклонение лишней боли с подтверждением.
  - **Mini App с данными:** `GET /api/panel` в `apps/api` — только владельцу по свежей подписи Telegram `initData`, CORS только для Mini App, каждый просмотр и чужая попытка — в журнале доступа. Mini App показывает стоп-кран, решения, деньги с полосками лимитов, тесты и поток цикла; только просмотр, без секретов в сборке.
  - **Docker-образ `apps/api/Dockerfile`**, инструкция [`deploy/api.md`](deploy/api.md).
- **PHASE 17 — Reward Engine (D-020, §2.10, D-006):**
  - **`/contribution`:** вклад участника команды (короткое имя, вид, тест по желанию) — с подтверждением; проверяет владелец кнопками ✅ / ❌ в `/rewards`.
  - **Правила** (`@roi-dealer/rewards`): фиксированная сумма или доля чистой выручки теста (до 50 %); сумму считает код, вклады — только подтверждённые, одного человека, один раз.
  - **`/reward`** создаёт начисление и запрос `payout` в `/decisions`; ✅ → к выплате, ❌ → отмена.
  - **`/paid`:** владелец переводит сам и отмечает выплату — она становится расходом «Люди» месяца.
  - **Миграция `0014`:** триггер базы не даст начислить неподтверждённый, чужой или уже начисленный вклад.
  - Строка в дайджесте, начисления в `/history`.
- **PHASE 19a — Media Factory, минимум (D-022, D-012):**
  - **Агент «Автор лендингов»** (`@roi-dealer/media`, задача `write-landing`): для теста с лендингом пишет страницу и три рекламных текста. Код отклоняет выдуманные отзывы, цифры, гарантии, ссылки и не-английский текст; цену и пометку «в разработке» / «предзаказ с возвратом» ставит код.
  - **17-я сущность `MediaAsset`:** черновик → одобрен / отклонён (дальше — выпуск в PHASE 21); один живой лендинг на тест; миграция `0015`.
  - **Пульт:** карточка «🎨 Лендинг» приходит сама — ✅ одобрить или ❌ переписать (до двух раз), с подтверждением; строка в `/experiments`; стоимость одобренного лендинга в `/economics`.
  - **Предпросмотр `GET /p/<token>`** в `api` (`@roi-dealer/site`): статичная страница без скриптов, строгий CSP, `noindex`; ссылка в карточке — с `PUBLIC_API_URL` у бота.
- **Фаза 13a (по запросу владельца, [ADR-0003](ADR/0003-early-telegram-owner-bot.md)):** бот-пульт в Telegram — только владелец, `/start` `/status` `/help`, уведомления о запуске / остановке, long polling; пакет `@roi-dealer/telegram`; Docker-образ `apps/bot/Dockerfile` (собирается в CI); инструкция [`docs/deploy/telegram-bot.md`](deploy/telegram-bot.md).
- **По запросу владельца после PHASE 00:** публикация placeholder miniapp на GitHub Pages (https://userpr0.github.io/roi-dealer/) для открытия в Telegram — [ADR-0002](ADR/0002-miniapp-hosting-github-pages.md), workflow `.github/workflows/miniapp-pages.yml`.

## Not Implemented

- Customer / Lead / Product, публикация лендингов, заявки и оплаты — PHASE 21, 20, 20b (D-022); картинки и видео — 19b.
- Сервисы worker и api в Railway — создаёт владелец ([worker](deploy/worker.md), [api](deploy/api.md)); staging — после тестового бота (A5).
- Другие источники данных — после проверки их условий (каталог); пока источник один, боли остаются кандидатами (для подтверждения нужны 2 источника).
- Размеры рынков и конкуренты вне Evidence — только с разрешённым источником таких данных (§2.5); AI-агент закономерностей в решениях — когда их накопится; ручное слияние болей — не нужно (дубли ловит `match-pain`).
- Ключи AI в Railway — вписывает владелец ([инструкция](deploy/worker.md#ai-ключи-phase-09)); до этого AI выключен, Evidence чистится правилами.
- Подключение команды к боту (роль `member` в Telegram) — когда появится команда (D-004); учётные данные сервисных аккаунтов для внешнего API — с первым внешним клиентом; настраиваемая политика одобрений — PHASE 16.
- Ручное добавление Evidence — нужен отдельный источник каталога с проверенными правилами; настройки уведомлений и дня разбора — когда понадобятся (§2.15).
- Участники команды в боте (роль `member` в Telegram) — когда появится команда (D-004); пока вклады записывает владелец. Платёжные провайдеры и автоматические выплаты — Уровень 3.
- Temporal и S3-compatible storage (placeholders в `infra/README.md`).
- Metrics, tracing, alerts; deployment backend-сервисов; production cloud resources.

## Applications

| App            | Состояние                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`     | `GET/HEAD /health` (+ проверка `database`, если задан `DATABASE_URL`), `GET /api/panel` для Mini App — владельцу по подписи Telegram, CORS только для Mini App (PHASE 13); `GET /p/<token>` — предпросмотр лендинга (PHASE 19a); 404 / 405 / 500 обработка, correlation id, access log, graceful shutdown; Docker-образ; в облаке — после создания сервиса владельцем                                                                                                                                                                                                           |
| `apps/worker`  | heartbeat, graceful stop; с `DATABASE_URL` — сбор Evidence по расписанию (PHASE 05); с ключами AI — проверка моделей, evals, вычистка имён, расходы AI (PHASE 09), четыре агента по общему расписанию — боли (PHASE 06), возможности (PHASE 07), исследования и рыночный контекст (PHASE 10), судьи (PHASE 11), гипотезы (PHASE 14), проверка трат (PHASE 16), автор лендингов (PHASE 19a); Docker-образ с миграциями; в облаке — после создания сервиса владельцем                                                                                                             |
| `apps/miniapp` | React 19 + Vite 8, на GitHub Pages: стоп-кран, решения, деньги с полосками лимитов, тесты, поток цикла из `api` (PHASE 13); только просмотр                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/bot`     | Бот-пульт (13a–13b, PHASE 04, 06–10): `/status`, уведомления; с `DATABASE_URL` — решения (запросы и карточки возможностей, которые приходят сами), стоп-кран, журнал, история, дайджест, `/access`, журнал доступа, `/pains`, `/opportunities`, `/search`, `/ask`, `/note`, `/hypotheses`, `/experiments`, `/funnel`, `/economics`, `/cost`, `/agents`, `/stats`, `/review`, `/portfolio`, недельный разбор и алерты (PHASE 13), `/rewards`, `/contribution`, `/reward`, `/paid` (PHASE 17), карточки лендингов (PHASE 19a); работает в Railway (EU West) с облачной PostgreSQL |

## Packages

| Package                      | Состояние                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@roi-dealer/shared`         | Реализован: `loadConfig`, `createShutdownManager`, `installProcessHandlers`                                                                                                                                                                                                                                                                                                |
| `@roi-dealer/observability`  | Реализован: `createLogger`, `createHealthRegistry`, `resolveCorrelationId`                                                                                                                                                                                                                                                                                                 |
| `@roi-dealer/telegram`       | Реализован (13a–13b, PHASE 04): клиент Bot API, inline-кнопки, long polling, owner-only router команд и кнопок с передачей отказов, notifier, проверка подписи Mini App `verifyInitData` (PHASE 13)                                                                                                                                                                        |
| `@roi-dealer/command-center` | Реализован (13b, PHASE 04, 06–17): одобрения, карточки возможностей и решения, стоп-кран, журнал, история, дайджест, время по Киеву; доступы и журнал доступа; боли, возможности с рынком и судьями, поиск, вопросы, заметки, агенты; гипотезы, тесты, экономика; статистика, недельный разбор, портфель, снимок для Mini App; вклады и вознаграждения; карточки лендингов |
| `@roi-dealer/agents`         | Реализован (PHASE 10): определение агента, `runAgent`, общий планировщик, агенты исследований и рыночного контекста с задачами `research-query` и `market-context`, гипотез (PHASE 14), автор лендингов (PHASE 19a)                                                                                                                                                        |
| `@roi-dealer/media`          | Реализован (PHASE 19a): задача `write-landing`, проверка текста кодом, цена и пометка, шаблон `renderLanding`                                                                                                                                                                                                                                                              |
| `@roi-dealer/site`           | Реализован (PHASE 19a): страницы для `api` — предпросмотр лендинга                                                                                                                                                                                                                                                                                                         |
| `@roi-dealer/judges`         | Реализован (PHASE 11): задача `judge-opportunity`, проверка оценок, агент судей                                                                                                                                                                                                                                                                                            |
| `@roi-dealer/brain`          | Реализован (PHASE 08): поиск с похожими записями, вопросы с ответом из БД, заметки владельца, `similarCases`                                                                                                                                                                                                                                                               |
| `@roi-dealer/policies`       | Реализован (PHASE 04): роли и права, проверка доступа                                                                                                                                                                                                                                                                                                                      |
| `@roi-dealer/domain`         | Реализован (PHASE 01, 13b, PHASE 04–05, 09): 17 сущностей (с `SystemControl`, `Principal`, `SourceSnapshot`, `MediaAsset`), value objects, lifecycles, правила, приватность Evidence, бюджет AI на день, формат рыночного контекста, критерии судей и итог `judgePanel`, рекомендация `recommendOpportunity`, выплата вознаграждения `recordRewardPayout`                  |
| `@roi-dealer/opportunities`  | Реализован (PHASE 07): агент возможностей, задача `frame-opportunity`, оценка 0–100, Business Model Router                                                                                                                                                                                                                                                                 |
| `@roi-dealer/signals`        | Реализован (PHASE 06): агент болей и сигналов, задачи `extract-signal` и `match-pain`, проверка цитат, группировка                                                                                                                                                                                                                                                         |
| `@roi-dealer/ai-runtime`     | Реализован (PHASE 09): `runTask`, адаптеры Claude / GPT / Gemini, порядок по evals, бюджет, evals, задача `redact-names`, обслуживание                                                                                                                                                                                                                                     |
| `@roi-dealer/evidence`       | Реализован (PHASE 05, 10): каталог источников, коннекторы Hacker News (список Ask HN и поиск), очистка персональных данных, сбор с provenance, расписание                                                                                                                                                                                                                  |
| `@roi-dealer/schemas`        | Реализован (PHASE 01): строгие входные контракты, `parseInput`                                                                                                                                                                                                                                                                                                             |
| `@roi-dealer/database`       | Реализован (PHASE 02–09, 13b): подключение в UTC, миграции, 17 репозиториев с событиями, проверкой прав и `listByStatus`, Event History, идемпотентные команды, журналы доступа, вызовов AI, разбора, оценок, агентов и судей; запросы поиска, экономики и статистики; health check                                                                                        |
| `@roi-dealer/events`         | Реализован (PHASE 03): контракты событий, correlation id, ключи идемпотентности                                                                                                                                                                                                                                                                                            |
| `@roi-dealer/economics`      | Реализован (PHASE 16): отчёт месяца `monthReport`, автопауза при аномальных тратах                                                                                                                                                                                                                                                                                         |
| `@roi-dealer/rewards`        | Реализован (PHASE 17): правила `fixed-v1` и `revenue-share-v1`, проверки `planReward`                                                                                                                                                                                                                                                                                      |
| `skills`                     | Placeholder: `PACKAGE_NAME` + README с назначением и Phase                                                                                                                                                                                                                                                                                                                 |

## Infrastructure

- `infra/docker/compose.yaml`: `postgres` (PostgreSQL 18.6, `postgres:18-alpine`) — `pnpm infra:up` / `infra:down` / `infra:logs`.
- Проверено: healthy, подключение, `timezone = UTC`, `uuidv7()`, сохранение данных после `down`/`up`, порт только на `127.0.0.1`.
- Схема: миграции `database/migrations/0001_core_domain.sql`, `0002_event_history.sql`, `0003_system_control.sql`, `0004_identity_access.sql`, `0005_evidence_engine.sql`, `0006_ai_runtime.sql`, `0007_signals_pain.sql`, `0008_opportunity_engine.sql`, `0009_company_brain.sql`, `0010_agents.sql`, `0011_judges.sql`, `0012_experiments.sql`, `0013_economics.sql`, `0014_rewards.sql`, `0015_media.sql` (`pnpm db:migrate`; в образах бота и worker — `migrate-cli.js`, проверено на пустой БД и повторном запуске; в облаке применены 0001–0004 при Уровне 1); integration-тесты создают на сервере временные БД и удаляют их.
- Temporal, object storage — только placeholders.

## Tests

| Набор       | Файлы | Тесты | Результат |
| ----------- | ----- | ----- | --------- |
| unit        | 49    | 545   | pass      |
| integration | 28    | 265   | pass      |

Integration-тесты запускают реальные процессы api / worker / bot (SIGTERM, SIGINT, exit codes, некорректная конфигурация), реальный HTTP-сервер, поддельный Telegram Bot API и PostgreSQL 18: миграции, все репозитории, ограничения БД в обход домена, Event History и идемпотентные команды, полный цикл DoD v0.1 с сохранением и полной историей событий; пульт 13b — одобрение, стоп-кран, журнал и дайджест на настоящей БД и в процессе бота через поддельный Bot API с нажатиями кнопок; PHASE 04 — права на каждой записи, отказы в журнале доступа (в том числе после отката), защита БД от записи без личности, выдача и отзыв доступа из пульта, попытки посторонних; PHASE 05 — сбор с фейковым Hacker News: каталог, доступ, стоп-кран, очистка персональных данных, дедупликация, provenance, ограничения БД, процесс worker; PHASE 09 — фейковые API Anthropic, OpenAI и Gemini: evals и их отчёты, порядок по evals, классы сбоев и переход на другого провайдера, бюджет дня и долей, стоп-кран, вычистка имён в Evidence, процесс worker с тремя провайдерами; PHASE 06 — агент болей на настоящей БД и фейковом AI: доступ, evals, сигналы с проверкой цитат, группировка и подтверждение болей, разбор каждого Evidence один раз, остановки, `/pains`, процесс worker; PHASE 07 — агент возможностей: доступ, eval, проверка цитат о деньгах, оценка и бизнес-модель, повторная оценка выросшей боли, остановки, `/opportunities`, процесс worker от поста до черновика возможности; PHASE 08 — поиск по всем видам записей, похожие записи, ввод с операторами и SQL, ответы `/ask` из БД, `/note` с подтверждением и идемпотентностью; PHASE 10 — общий запуск агентов (стоп-кран, доступ, журнал), исследование через фейковый HN Search с очисткой и дедупликацией, рыночный контекст только с подтверждёнными цитатами, `/agents`, процесс worker с четырьмя агентами до рыночного контекста; PHASE 11 — судьи: шесть отдельных вызовов, проверка баллов и ссылок, ожидание рынка, продолжение после остановки, `under_review`, процесс worker до очереди владельца на трёх сильных моделях; PHASE 12 — карточка и рекомендация, подтверждение и одно решение на нажатие, устаревшие карточки, «доисследовать» до новых сигналов, рассылка один раз на версию со стоп-краном, процесс бота: карточка приходит сама и решается двумя нажатиями; PHASE 14 — проверки полей и набора гипотез, исправление по списку нарушений, `rejected`, `/hypotheses`, уведомление один раз, процесс worker до пяти гипотез после ✅; PHASE 15 — выбор гипотезы, чек-лист и запрос запуска, ✅ в `/decisions`, старт, `/funnel` с затратами в пределах одобренного, автостоп по stop-loss, итоги «сменить подход» и «масштабировать», отказ закрыть возможность при другом тесте, CHECK чек-листа и защита журнала воронки; PHASE 16 — выручка и возвраты из `/funnel` с unit economics, `/cost` с одобрением выше $20, `/economics` по журналам, журнал выручки только для владельца, автопауза при 2× и одно сообщение о ней; PHASE 13 — `/stats` из БД, алерты, недельный разбор один раз с предложением и кнопками, `/portfolio` с отказом при открытых тестах, отклонение болей, `GET /api/panel` на настоящем HTTP-сервере: владелец, чужой аккаунт, поддельные и устаревшие подписи, CORS; PHASE 17 — вклад и проверка кнопками, начисление по правилу, ✅ / ❌ выплаты в `/decisions`, `/paid` с расходом «Люди» один раз, доля выручки из журнала, отказы, отмена с закрытием запроса, триггер базы; PHASE 19a — агент лендингов на фейковом Claude: доступ и eval, черновик один раз, карточка и строка теста, предпросмотр на настоящем HTTP-сервере с заголовками, ❌ → переписывание с правкой выдумки → ✅ владельца, предел переписываний, один живой лендинг в базе.

## Этап A — настройка владельцем

- ✅ **A2:** `main` — основная ветка; ruleset `Protect main` активен ([файл](deploy/github-ruleset-protect-main.json)): изменения только через pull request, обязательные проверки CI `Typecheck, lint, test, build` и `Build bot Docker image`, запрет force push и удаления. Claude работает в рабочей ветке и открывает PR, вливает владелец.
- ✅ **A3 (GitHub):** Secret Protection и push protection включены. Двухфакторка аккаунтов — на стороне владельца.
- ✅ **A1:** бот-пульт работает в Railway (регион EU West, 1 реплика, лимиты 1 vCPU / 0.5 GB), деплой из `main` после зелёного CI; 2026-09-25 прислал «🟢 ROI Dealer bot запущен». Настройки — [`deploy/telegram-bot.md`](deploy/telegram-bot.md).
- ✅ **A4 (Railway):** лимиты использования заданы владельцем ($15 оповещение, $20 жёсткий лимит).
- ⏳ **A5:** тестовый бот для локальной разработки — [инструкция](deploy/owner-setup.md).
- ✅ **A6:** инструкции на аварии — [`docs/runbooks/`](runbooks/README.md): утечка токена или ключа, сервис не работает, резкий рост расходов.

## Known Issues

- Для miniapp нет автоматического теста рендеринга (проверено вручную: build + Chromium, ошибок в консоли нет).
- Подпись Mini App (`initData`) проверена по алгоритму Telegram в тестах и в контейнере `api`; живой Telegram из облачной среды разработки недоступен. Типы снимка в Mini App повторяют `PanelSnapshot` — менять в обоих местах.
- Сайты источников недоступны из облачной среды разработки: коннектор проверен на фейковом Hacker News, условия площадок — по документации и вторичным источникам (записано в каталоге). Первая реальная загрузка — после запуска worker в Railway.
- Имена людей внутри текста вычищает AI (PHASE 09) — только когда в worker есть ключи; без них остаются правила.
- API AI-провайдеров недоступны из облачной среды разработки: адаптеры проверены на фейковых серверах; цены OpenAI — по сторонним сводкам ([ADR-0006](ADR/0006-ai-providers-and-runtime.md)).
- Подтверждения `/stop` и `/resume` хранятся в памяти бота: после перезапуска бот просит повторить команду.
- Минимальное число элементов в списках id и существование объекта полиморфной ссылки `subject` проверяет домен, а не БД ([схема](../database/docs/schema.md)).
- В Railway бот показывает версию `dev`: переменная `APP_VERSION` не задана, поэтому по сообщению не видно, какой коммит выкачен.
- Живой Telegram API недоступен из облачной среды разработки — бот проверен на поддельном Bot API и в Docker-контейнере.

## Next Allowed Phase

**Уровень 2 собран:** все фазы D-020 (05 → … → 13 → 17) — PASS и ждут вливания PR. **Уровень 3 одобрен (D-022):** 19a — PASS; **следующая — PHASE 21 Solution Factory** (Release Gate §7.2, публикация страницы на `api`, события воронки), затем 20 CRM / Outcomes и 20b приём оплат. Тестовый бот (A5) нужен для staging и запуска на ПК; разработку не блокирует.

Действия владельца для PHASE 05–17 ([worker](deploy/worker.md), [api](deploy/api.md)):

1. Влить PR.
2. Создать сервис worker.
3. Одобрить «Доступ: Hacker News» в `/decisions`.
4. Включить копии БД.
5. Вписать ключи Claude, GPT и Gemini в Variables worker; лимиты в кабинетах — в сумме ≤ $50/мес.
6. Одобрить в `/decisions` доступ шести агентов: болей и сигналов, возможностей, исследований, рыночного контекста, судей и гипотез.
7. Пульт с данными: сервис `api` в Railway и переменная GitHub `MINIAPP_API_URL`.
8. Счета Railway вносить через `/cost`.
9. PHASE 19a: одобрить «Доступ: Автор лендингов» в `/decisions`; в Variables бота — `PUBLIC_API_URL` (адрес сервиса `api`).
