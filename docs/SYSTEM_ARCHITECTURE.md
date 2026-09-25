# ROI Dealer — System Architecture

> **Источник:** Implementation Playbook v1.1 — §1, §1.1, §3, §7, §7.1–7.3, §11–12 (перенесено дословно).
> Раздел **«Архитектура реализации»** описывает фактическое состояние repository и обновляется в каждой Phase.

## 1. Что мы создаём

ROI Dealer — AI-операционная система, которая:

1. находит реальные проблемы и рыночные возможности;
2. собирает и проверяет доказательства;
3. формирует Opportunity;
4. оценивает экономику, риски и способы монетизации;
5. создаёт 5 гипотез проверки;
6. запускает и измеряет эксперименты;
7. получает реальные рыночные сигналы, клиентов и деньги;
8. создаёт / покупает / лицензирует / улучшает решение;
9. измеряет Customer Outcome;
10. рассчитывает Contribution и Reward;
11. сохраняет знания, Skills, Assets, Patterns и историю;
12. использует накопленное знание для следующих циклов.

Главный замкнутый цикл:

```text
Source
→ Evidence
→ Signal
→ Pain
→ Opportunity
→ Business Model
→ 5 Hypotheses
→ Experiments
→ Customer / Revenue
→ Solution
→ Product
→ Customer Outcome
→ Reward
→ Knowledge / Skill / Asset
→ Company Brain
↺
```

Главный принцип:

> AI думает.
>
> Backend проверяет.
>
> PostgreSQL хранит authoritative state.
>
> Event History хранит историю.
>
> Temporal выполняет долгие workflows.
>
> Company Brain хранит знания.
>
> Владелец принимает стратегические решения.

### 1.1 Главный коммерческий цикл реализации

Claude Code должен оптимизировать систему не под количество написанного кода, а под скорость безопасного прохождения цикла:

```text
Real Pain / Opportunity
→ Evidence
→ 5 Validation Hypotheses
→ Minimum Sellable Product / Demo
→ Early User Crash Test
→ Public Market Test
→ Real User Action / Payment
→ Customer Outcome
→ Economics
→ Reward
→ Learning / Skill / Asset
→ Next Improved Cycle
```

Ключевая инженерная цель:

> Создать минимальную безопасную версию, которая позволяет проверить следующую бизнес-гипотезу реальным поведением пользователя и, когда уместно, реальной оплатой.

Не строить «идеальный продукт» до подтверждения необходимости его функций.

## 3. Главные системы организма

1. **Sensory System** — Sources, Evidence, Signals, Market Intelligence.
2. **Company Brain** — Knowledge, History, Patterns, Decisions.
3. **Opportunity & Decision System** — Pain, Opportunity, Business Model, Judges.
4. **Validation System** — 5 Hypotheses, Experiments, Causal Attribution.
5. **Distribution System** — Organic, Ads, Owned Distribution.
6. **Creative & Media Factory** — Brand, Persona, Media Orchestrator, QA.
7. **Solution & Product Factory** — Build/Buy/Improve/License/Partner.
8. **Customer & Outcome System** — CRM, Support, Voice of Customer, Outcomes.
9. **Economic System** — Costs, Revenue, Pricing, Unit Economics.
10. **Reward Engine** — Contributions, Reward Rules, Verification, Payout states.
11. **Skills & Improvement System** — Skills, Assets, Golden Sets, Evals.
12. **Reliability System** — Security, Observability, Incidents, Backups.
13. **Portfolio System** — Products, Capital Allocation, GEO Expansion.
14. **Owner Command Center** — Approvals, Risks, Costs, Decisions, Health.
15. **MVP Scope Governor** — Feature Kill Gate, Minimum Sellable Product и контроль scope до подтверждения спроса.
16. **Input Router / Capture Layer** — будущий low-friction вход text/voice/webhook → typed intent → confirmation → backend action.
17. **Early User Validation Layer** — design partners, crash tests и release gate перед публичным трафиком.

---

## Архитектура реализации (as built — PHASE 03)

### Стиль

TypeScript **modular monolith** в pnpm monorepo:

- `apps/*` — развёртываемые процессы (тонкий транспортный слой, без бизнес-логики);
- `packages/*` — библиотеки: домен, контракты, политики, AI runtime, экономика, observability;
- `workflows/*` — Temporal workflows (появятся с Temporal; сейчас только README);
- `database/*` — SQL-миграции и документация схемы PostgreSQL (PHASE 02).

### Runtime-компоненты

```text
                    ┌──────────────────────┐
 Owner ── Telegram ─┤ miniapp (React/Vite) ├──HTTP──┐
                    └──────────────────────┘        │
                    ┌──────────────────────┐        ▼
 Telegram ──────────┤ bot                  ├──► ┌────────┐      ┌──────────────────────────┐
                    └──────────────────────┘    │  api   ├─────►│ PostgreSQL               │
                                                └────────┘      │ authoritative state      │
                    ┌──────────────────────┐                    │ + append-only history    │
 Temporal ──────────┤ worker               ├───────────────────►└──────────────────────────┘
                    └──────────────────────┘
                     └─► ai-runtime ─► AI providers (заменяемые)   └─► S3-compatible storage
```

| Компонент             | Статус в PHASE 00                                                                                                                                                                                                                                         | Появится                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/api`            | `GET /health`, structured logs, correlation id, graceful shutdown                                                                                                                                                                                         | Бизнес-API — по Phase                                                                                 |
| `apps/worker`         | Lifecycle: start, heartbeat, graceful shutdown                                                                                                                                                                                                            | Temporal workers — после выбора интеграции Temporal                                                   |
| `apps/miniapp`        | Placeholder-экран, опубликован на GitHub Pages и открывается кнопкой бота (ADR-0002); без Telegram SDK                                                                                                                                                    | PHASE 13 — Owner Command Center                                                                       |
| `apps/bot`            | Бот-пульт владельца (13a, ADR-0003; 13b): только владелец, `/status`, уведомления, long polling; с `DATABASE_URL` — одобрения с подтверждением, стоп-кран, журнал, история, дайджест 10:00 Kyiv (`@roi-dealer/command-center`); Docker-образ с миграциями | Alerts, Input Router, Mini App с данными — PHASE 13+                                                  |
| PostgreSQL 18         | Docker Compose (локально), сервис в CI; схема 14 сущностей (миграции `0001`–`0003`); доступ — `@roi-dealer/database`; `api` и `bot` проверяют БД в health, если задан `DATABASE_URL`                                                                      | Облачная БД — создаёт владелец ([инструкция](deploy/database.md)); миграции — Pre-deploy Command бота |
| Temporal              | Не запущен                                                                                                                                                                                                                                                | Отдельный шаг с ADR                                                                                   |
| S3-compatible storage | Не запущен                                                                                                                                                                                                                                                | При первой потребности (Evidence snapshots, media)                                                    |

### Направления зависимостей

```text
apps/*  ──►  packages/*          (никогда наоборот)
packages/domain                  без I/O: не импортирует БД, сеть, AI
packages/agents, packages/judges ──► packages/ai-runtime  (не напрямую к провайдерам)
apps/bot ──► packages/telegram     (Telegram Bot API только через этот пакет)
apps/bot ──► packages/command-center ──► packages/database, packages/telegram, packages/domain   (логика пульта, 13b)
apps/* ──► packages/database ──► packages/events ──► packages/domain   (PostgreSQL только через database)
packages/*  ──►  packages/shared, packages/observability
```

- AI (agents / judges через `ai-runtime`) возвращает **предложения**; изменение authoritative state выполняет backend после проверок (§2.3).
- Каждый пакет объявляет зависимости явно (`workspace:*`); скрытых path aliases нет.
- Пакеты экспортируют `dist/` для runtime и `src/` через export condition `@roi-dealer/source` для dev/test (см. `docs/TECH_STACK.md`).

### Размещение систем организма

| Система                             | Где будет жить                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Sensory System                   | `packages/domain` (Source, Evidence, Signal), `workflows/discovery`                                                                                                   |
| 2. Company Brain                    | `packages/domain` + PostgreSQL (PHASE 08)                                                                                                                             |
| 3. Opportunity & Decision           | `packages/domain`, `packages/judges`, `workflows/opportunity`                                                                                                         |
| 4. Validation System                | `workflows/validation` (PHASE 14–15)                                                                                                                                  |
| 5–6. Distribution, Creative & Media | Отдельные модули в поздних Phase (PHASE 19)                                                                                                                           |
| 7. Solution & Product Factory       | `workflows/solution` (PHASE 21–22)                                                                                                                                    |
| 8. Customer & Outcome               | PHASE 20                                                                                                                                                              |
| 9. Economic System                  | `packages/economics` (PHASE 16)                                                                                                                                       |
| 10. Reward Engine                   | `packages/rewards`, `workflows/reward` (PHASE 17)                                                                                                                     |
| 11. Skills & Improvement            | `packages/skills`, `workflows/improvement` (PHASE 18, 23)                                                                                                             |
| 12. Reliability System              | `packages/observability` (реализован базовый слой), `infra/`                                                                                                          |
| 13. Portfolio System                | PHASE 22                                                                                                                                                              |
| 14. Owner Command Center            | `apps/miniapp`, `apps/bot` + `packages/telegram` + `packages/command-center` (бот-пульт — 13a; одобрения, стоп-кран, журнал, дайджест — 13b; полный пульт — PHASE 13) |
| 15. MVP Scope Governor              | `packages/policies` + Experiment Engine (PHASE 15)                                                                                                                    |
| 16. Input Router / Capture Layer    | `packages/telegram` (типизированные команды) → `apps/bot`, `apps/api` — typed intent → confirmation → backend action (после PHASE 13)                                 |
| 17. Early User Validation Layer     | PHASE 20–21                                                                                                                                                           |

### Доменная модель (PHASE 01)

`@roi-dealer/domain` — единственное место, где описаны сущности и правила. Backend, бот, workflows и агенты меняют состояние **только** через его функции:

```text
untrusted JSON ──parseInput(createInputSchemas.x)──► typed data ──createX / transition(ctx)──► new entity version
                  (@roi-dealer/schemas: strict)                   (@roi-dealer/domain: rules, owner gates)
```

- Изменяемые сущности: `version` + `updatedAt` (optimistic locking — PHASE 02, см. «Хранение»); неизменяемые записи (Evidence, Decision, CostEntry, KnowledgeAsset) исправляются новыми записями.
- Решения владельца (Decision, ApprovalRequest, верификация вклада, одобрение Reward) закреплены за актором `owner` в домене, а не только в интерфейсе.
- Спецификация и правила — [`docs/phases/01_core_domain.md`](phases/01_core_domain.md).

### Хранение (PHASE 02)

`@roi-dealer/database` сохраняет сущности домена в PostgreSQL ([ADR-0005](ADR/0005-postgresql-driver-and-migrations.md), [схема](../database/docs/schema.md)):

```text
domain function ──► new entity version ──► repository.update ──► UPDATE … WHERE version = N − 1
                                                   (database.transaction: несколько записей атомарно)
repository.getById ──► row ──► domain schema ──► entity   (иначе DataIntegrityError, §2.13)
```

- БД проверяет структуру (типы, ссылки, деньги, время, human gates) и защищает историю: неизменяемые записи и связи нельзя изменить или удалить, строки не удаляются, каждая новая версия — `version + 1`.
- Домен по-прежнему решает, кто и какой переход может выполнить.
- Миграции — SQL-файлы в `database/migrations/`, только вперёд, с контрольными суммами; `pnpm db:migrate`.

### Event History (PHASE 03)

```text
repository.insert / update ──► row + event (<entity>.created | .updated, version, actor, correlation_id, snapshot)
                                 └─ одна транзакция; при COMMIT БД проверяет, что у каждой изменённой строки есть событие
database.command({ idempotencyKey }) ──► idempotency_keys ──► выполнить ровно один раз, повтору — сохранённый результат
database.events.history(entity) / list({ from, to, … }) ──► журнал и история (кнопки пульта, 13b)
```

- События — аудит изменений (§2.2, §2.11): кто, когда, какая версия, в рамках какого запроса. Изменить или удалить событие нельзя.

### Пульт владельца (13b)

```text
Telegram ──► router (только владелец, личный чат) ──► command-center
  /decisions ──► карточка ──► ✅/❌ ──► вопрос «Одобрить … на $X?» ──► Да ──► database.command(tg-callback-<id>)
                                                                             └─► resolveApprovalRequest (owner) ──► update + event
  /stop, /resume ──► подтверждение (10 мин) ──► database.command ──► pauseSystem / resumeSystem ──► SystemControl + event
  /journal, /history ──► День / Неделя / Месяц ──► database.events.list ──► строки по Киеву
  10:00 Europe/Kyiv ──► database.command(digest-<дата>) ──► дайджест владельцу, не более раза в день
```

- **Стоп-кран** — сущность `SystemControl` (`automation`: `running` ⇄ `paused`). Остановить может владелец или система (будущая автопауза), возобновить — только владелец. Каждая будущая автоматизация и трата первым шагом вызывает `assertAutomationRunning`.
- Контракты событий — `@roi-dealer/events`; хранение — `@roi-dealer/database` ([схема](../database/docs/schema.md#event-history-phase-03)).

### Сквозные механизмы (реализованы в PHASE 00)

| Механизм           | Где                                                                      | Контракт                                                                                                 |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Config validation  | `@roi-dealer/shared` → `loadConfig`                                      | Zod-схема на процесс; пустые строки = не задано; ошибки без значений                                     |
| Structured logging | `@roi-dealer/observability` → `createLogger`                             | JSON line: `timestamp`, `level`, `service`, `message`, `correlation_id?` + поля; редактирование секретов |
| Correlation id     | `@roi-dealer/observability` → `resolveCorrelationId`                     | Заголовок `x-correlation-id`; валидация формата, иначе UUID                                              |
| Health             | `@roi-dealer/observability` → `createHealthRegistry`                     | `{status, service, checks?}`; `down` → HTTP 503; сырые ошибки не раскрываются                            |
| Graceful shutdown  | `@roi-dealer/shared` → `createShutdownManager`, `installProcessHandlers` | SIGTERM/SIGINT → hooks в обратном порядке, timeout 10 s; повторный сигнал → exit 1                       |

## 7. Полная карта реализации

- **PHASE 00 — Project Bootstrap:** инженерный фундамент repository.
- **PHASE 01 — Core Domain:** доменные сущности и типизированные схемы.
- **PHASE 02 — PostgreSQL Foundation:** migrations, repositories, constraints, UUID, UTC.
- **PHASE 03 — Event History:** append-only event store, audit, idempotency.
- **PHASE 04 — Identity / RBAC / Security:** users, roles, permissions, agent identity, service accounts.
- **PHASE 05 — Evidence Engine:** sources, snapshots, evidence, claims, provenance, trust.
- **PHASE 06 — Signals & Pain:** normalization, clustering, pain candidates.
- **PHASE 07 — Opportunity Engine:** opportunity scoring, market context, Business Model Router.
- **PHASE 08 — Company Brain v0.1:** knowledge, decisions, similar-case retrieval, history.
- **PHASE 09 — AI Runtime:** provider abstraction, Model Router, costs, retries, schema validation.
- **PHASE 10 — Agents:** Research, Pain, Market Context, Opportunity, Knowledge.
- **PHASE 11 — Judges:** Market, Pain/Value, Economics, Buildability, Risk, Reuse.
- **PHASE 12 — Decision Engine:** APPROVE / REJECT / MORE_RESEARCH / PAUSE / KILL / SCALE.
- **PHASE 13 — Owner Command Center:** Telegram Mini App + typed command foundation; future Input Router must require confirmation for state-changing actions.
- **PHASE 14 — Five Hypothesis Engine:** 5 distinct validation hypotheses with lineage, including offer/pricing/monetization and demo/outcome hypotheses where relevant.
- **PHASE 15 — Experiment Engine:** budgets, metrics, stop-loss, states, results, Minimum Sellable Product gate and Feature Kill Gate.
- **PHASE 16 — Economics:** Cost Ledger, Revenue Ledger, Unit Economics, refunds, budgets, free-tier cost and lifetime-deal liability modeling.
- **PHASE 17 — Reward Engine:** contributions, rules, verification, calculation, payable state.
- **PHASE 18 — Skill Registry:** lifecycle, Golden Sets, Evals, permissions, dependencies.
- **PHASE 19 — Media Factory:** Creative Brief, Brand Kit, Persona, Media Jobs, Preview, QA.
- **PHASE 20 — CRM / Customer / Outcomes:** leads, deals, customers, support, outcomes, Voice of Customer and Early User Crash Test evidence.
- **PHASE 21 — Solution Factory:** Build/Buy/Improve/License/Partner, Minimum Sellable Product, QA, deployment and Productization Review.
- **PHASE 22 — Product & Portfolio:** registry, profitability, kill/merge/scale, capital allocation.
- **PHASE 23 — Controlled Self-Improvement:** champion/challenger, sandbox, approval, rollback.

## 7.1 Fast Commercial Validation Protocol

Этот протокол применяется после того, как соответствующие Phase реализованы. Он определяет, как ROI Dealer должен быстро переводить Opportunity в рыночную проверку.

### Step A — Confirm the pain

Не строить продукт из одной идеи. Нужны Evidence и понятный ICP.

Выход:

```text
Pain Card + Evidence + Target ICP + Desired Outcome
```

### Step B — Create five hypotheses

Пять гипотез должны различаться по способу проверки, а не быть пятью копиями одного креатива.

Каждая фиксирует:

```text
Audience
GEO
Offer
Price
Channel
Creative / Demo
CTA
Success metric
Budget
Stop-loss
Minimum data
```

### Step C — Select the smallest testable product

Для каждой гипотезы определить, что реально необходимо построить.

Предпочитать:

```text
Demo
Landing
Clickable prototype
Single-function app
Concierge/manual backend
Minimal automation
```

до полноценного SaaS, если эти варианты достаточно хорошо проверяют willingness to pay и outcome.

### Step D — Build under an Experiment Build Budget

До начала сборки зафиксировать:

- max money;
- max AI/API cost;
- max human time;
- max calendar time;
- expected evidence produced;
- kill criteria.

### Step E — Internal QA and Retrieval Check

До внешних пользователей:

1. critical flows проходят;
2. authoritative data извлекаются из DB/tool, а не prompt memory;
3. analytics events записываются;
4. secrets не находятся на клиенте;
5. cost limits работают;
6. rollback/recovery существует.

### Step F — Early User Crash Test

Небольшая группа реальных пользователей проходит продукт без подсказок автора.

Цель — найти не косметические замечания, а blocking defects и несоответствие mental model пользователя.

### Step G — Public Market Test

Только после crash-test запускается контролируемый трафик.

Отслеживать полную цепочку:

```text
Impression
→ Attention
→ CTA
→ Activation
→ Lead / Trial
→ Payment
→ Product Use
→ Outcome
→ Retention / Repeat
```

### Step H — Learn before expanding scope

После теста возможны только четыре базовых решения:

```text
SCALE
IMPROVE
PIVOT
KILL
```

Новые функции не добавлять автоматически. Сначала обновить Company Brain, Evidence, Experiment Result и Unit Economics.

---

## 7.2 Public Validation Release Gate

Продукт нельзя направлять на значимый публичный/платный трафик, пока не выполнены применимые пункты:

- [ ] основной user journey проходит end-to-end;
- [ ] ключевые DB retrieval сценарии протестированы;
- [ ] нет known P0/P1 bugs;
- [ ] analytics/telemetry работают;
- [ ] пользовательские действия имеют idempotency там, где требуется;
- [ ] secrets отсутствуют в client bundle;
- [ ] authorization проверена;
- [ ] AI/API cost caps настроены;
- [ ] payment flow протестирован, если он входит в гипотезу;
- [ ] refund/cancel path определён, если применимо;
- [ ] error/recovery state существует;
- [ ] Early User Crash Test завершён;
- [ ] value proposition описывает outcome, а не только AI-функцию;
- [ ] success metric и stop-loss зафиксированы до запуска.

---

## 7.3 Authoritative Question Protocol

Для функций типа «Сколько мы потратили?», «Какой статус сделки?», «Какая гипотеза победила?», «Сколько начислено Reward?» реализовать следующий шаблон:

```text
1. Parse user intent.
2. Resolve entity and authorization.
3. Query authoritative source.
4. Validate freshness/completeness.
5. Compute deterministic aggregates in code/SQL where practical.
6. Pass facts to AI only for explanation/summarization.
7. Return answer with relevant provenance/audit metadata.
```

Нельзя просить LLM «вспомнить» числа из предыдущего чата вместо DB query.

## 11. Definition of Done ROI CORE v0.1

Первая настоящая версия ROI Dealer считается существующей, когда система способна выполнить:

```text
START SYSTEM
↓
collect source data
↓
create Evidence
↓
detect Signal
↓
create Pain candidate
↓
create Opportunity
↓
retrieve historical knowledge
↓
run Judges
↓
show Owner Decision
↓
Owner APPROVE
↓
create 5 Hypotheses
↓
create Experiment Plan
↓
define Minimum Sellable Product / validation artifact
↓
record Costs and Experiment Build Budget
↓
record Contribution
↓
prepare Reward calculation
↓
save complete Event History
```

без ручного переноса данных между модулями.

### 11.1 Definition of Done — First Commercial Loop

ROI Dealer считается прошедшим первый практический коммерческий цикл, когда хотя бы одна Opportunity проходит:

```text
Pain + Evidence
→ Approved Opportunity
→ 5 Hypotheses
→ Minimum Sellable Product / Demo
→ Internal QA
→ Early User Crash Test
→ Controlled Public Test
→ Real target action or payment
→ Customer Outcome measurement
→ Unit Economics
→ Contribution / Reward state
→ Learning saved to Company Brain
→ SCALE / IMPROVE / PIVOT / KILL decision
```

Ключевым доказательством является не объём написанного кода, а подтверждённый рыночный результат и сохранённое обучение.

---

## 12. Главная установка Claude Code

Не оптимизируй проект ради количества функций или скорости написания кода.

Сначала спроси:

> Какой минимальный безопасный результат этого Phase позволит проверить следующую бизнес-гипотезу или надёжно подготовить систему к её проверке?

Оптимизируй проект ради:

- воспроизводимости;
- проверяемости;
- объяснимости;
- безопасности;
- заменяемости AI;
- сохранения истории;
- финансового контроля;
- возможности масштабирования;
- минимального vendor lock-in;
- устойчивости к ошибкам AI.

ROI Dealer должен становиться умнее после каждого цикла, но ни один AI-agent не должен обладать неограниченным контролем над системой.
