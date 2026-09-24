# ROI Dealer — Claude Code Implementation Playbook v1.1

**Назначение:** пошаговая техническая инструкция для Claude Code по сборке ROI Dealer с нуля как единой AI-операционной системы.  
**Версия:** 1.1  
**Дата:** 2026-09-24  
**Статус:** Architecture → Implementation

---

# 1. Что мы создаём

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
> Backend проверяет.  
> PostgreSQL хранит authoritative state.  
> Event History хранит историю.  
> Temporal выполняет долгие workflows.  
> Company Brain хранит знания.  
> Владелец принимает стратегические решения.

## 1.1 Главный коммерческий цикл реализации

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

---

# 2. Конституция ROI Dealer

Claude Code должен считать следующие правила архитектурными ограничениями.

## 2.1 Source of Truth
PostgreSQL является главным источником истины для бизнес-состояния.

Запрещено использовать как authoritative state:
- Telegram;
- чат AI;
- n8n;
- Temporal history;
- локальные JSON-файлы;
- prompt memory;
- внешний CRM.

## 2.2 Event History
Важная история бизнеса является append-only.

Событие нельзя переписывать или молча удалять. Исправление оформляется новым событием.

## 2.3 AI не изменяет authoritative business state напрямую
AI может вернуть предложение, оценку или структурированный результат, но не должен напрямую менять Opportunity, Experiment, Product, Reward, финансовый ledger или permissions.

Изменение состояния выполняется backend-кодом после:
- schema validation;
- permission check;
- policy check;
- budget check;
- state-transition validation;
- evidence requirements.

## 2.4 AI providers заменяемы
Нельзя привязывать доменную бизнес-логику к конкретной модели или провайдеру.

Бизнес-код должен вызывать абстрактную задачу:

```text
runTask(taskType, requirements, context)
```

Model Router выбирает подходящую модель.

## 2.5 Evidence First
Серьёзные AI-выводы должны ссылаться на Evidence. LLM output сам по себе не считается фактом.

## 2.6 Ограниченные автоматизации
Каждый workflow обязан иметь:
- max cost;
- timeout;
- retries;
- max AI calls;
- allowed external actions;
- stop conditions.

## 2.7 Human Gates
Критические действия требуют human approval:
- большие бюджеты;
- реальные выплаты;
- покупка активов;
- необратимые production changes;
- юридически чувствительные операции;
- high-risk deployments;
- доступ к секретам;
- изменения core policies.

## 2.8 Cost Accounting
С первого рабочего этапа учитывать стоимость AI, API, infrastructure, storage, media, ads, human work, refunds и vendors.

## 2.9 Every Cycle Leaves an Asset
Даже неуспешный эксперимент должен оставить хотя бы один актив: Evidence, Knowledge, Pattern, Skill, Asset, Failure Pattern, reusable code или market data.

## 2.10 Reward only from verified contribution
Reward связан цепочкой:

```text
Contributor
→ Contribution
→ Result
→ Verification
→ Reward Calculation
→ Approval
→ Payable
→ Paid
```

## 2.11 Security
Никогда не хранить реальные секреты в repository.

Использовать:
- environment variables только для локальной разработки;
- Secret Manager / Vault в production;
- least privilege;
- short-lived credentials;
- audit logs.

## 2.12 No silent architecture changes
Если Claude Code считает, что архитектурное решение нужно изменить, он обязан:
1. не менять его автоматически;
2. создать ADR proposal;
3. описать причину;
4. описать impact;
5. предложить альтернативы;
6. остановиться до approval владельца.

## 2.13 Retrieval Before Reasoning
Для любых authoritative-вопросов сначала получить факты из source of truth, затем формировать AI-ответ.

Это обязательно для:
- финансов;
- расходов и доходов;
- клиентов и сделок;
- статусов Opportunity / Hypothesis / Experiment / Product;
- Reward;
- пользовательских записей;
- фактической аналитики.

Запрещено отвечать на такие вопросы только из prompt memory, conversation memory или предположений модели.

Базовый порядок:

```text
User Question
→ classify intent
→ retrieve authorized records
→ validate freshness/completeness
→ reason over retrieved facts
→ answer with provenance
```

## 2.14 Minimum Sellable Product
До доказанного спроса Claude Code должен стремиться к минимальной безопасной версии продукта, за которую можно получить целевое действие или оплату.

Функция допускается в ранний продукт, если она:
1. решает подтверждённую боль; или
2. необходима для измеримого Customer Outcome; или
3. обязательна для безопасности, платежей, аналитики или надёжности; или
4. непосредственно нужна для проверки текущей гипотезы.

Иначе функция должна быть отложена в backlog.

## 2.15 Feature Kill Gate
Перед реализацией необязательной функции Claude должен указать:
- какую боль она решает;
- какую гипотезу проверяет;
- какую метрику изменяет;
- почему без неё нельзя провести текущий тест.

Если ответ отсутствует — функция не входит в текущий Phase.

## 2.16 Early User Crash Test
До масштабного или платного публичного трафика критические user journeys должны пройти тест реальными пользователями / design partners.

Обязательные проверки по применимости:
- happy path;
- пустые данные;
- неправильный ввод;
- повтор действия;
- потеря соединения;
- возврат после ошибки;
- retrieval из БД;
- платежный сценарий;
- лимиты;
- authorization;
- удаление/отмена;
- recovery.

Blocking-баги должны быть исправлены до public acquisition.

## 2.17 Outcome-first Product & Marketing
AI-возможность не считается самостоятельной ценностью.

Продукт, landing, demo и creative должны объяснять:
- проблему;
- изменение для пользователя;
- измеримый результат;
- доказательство результата.

Формулировка вида «AI-powered» не заменяет value proposition.

## 2.18 Monetization is a Hypothesis
Pricing и monetization тестируются как отдельные гипотезы:
- free limit / freemium;
- subscription;
- one-time purchase;
- setup fee;
- bundle;
- usage-based;
- outcome-based;
- lifetime deal.

Lifetime deal допускается как инструмент ранней validation/cash-flow, но Economics обязан учитывать будущую стоимость support, AI/API и инфраструктуры такого клиента.

## 2.19 Cheap Experiment, Strong Discipline
AI coding снижает стоимость попытки, но не отменяет:
- tests;
- security;
- source-of-truth discipline;
- audit;
- cost limits;
- release gates;
- rollback.

Цель — чаще проводить маленькие обратимые эксперименты, а не быстрее создавать технический долг.

---

# 3. Главные системы организма

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

# 4. Канонический технологический стек v1

- Runtime: TypeScript
- Frontend: React + TypeScript
- Control interface: Telegram Mini App
- Backend: TypeScript modular monolith
- Database: PostgreSQL
- Validation: Zod
- Workflow Engine: Temporal
- Storage: S3-compatible object storage
- AI Runtime: Provider abstraction + Model Router + structured outputs + cost tracking
- Integrations: official APIs / permitted connectors
- n8n: только внешний integration layer, не core orchestrator
- Infrastructure: cloud-first
- Secrets: managed Secret Manager / Vault
- Observability: structured logs + metrics + tracing + alerts
- Repository: monorepo

---

# 5. Целевая структура репозитория

```text
roi-dealer/
├── apps/
│   ├── api/
│   ├── worker/
│   ├── miniapp/
│   └── bot/
├── packages/
│   ├── domain/
│   ├── schemas/
│   ├── events/
│   ├── policies/
│   ├── agents/
│   ├── judges/
│   ├── skills/
│   ├── ai-runtime/
│   ├── economics/
│   ├── rewards/
│   ├── observability/
│   └── shared/
├── workflows/
│   ├── discovery/
│   ├── opportunity/
│   ├── validation/
│   ├── solution/
│   ├── reward/
│   └── improvement/
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── docs/
├── infra/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
└── docs/
    ├── CLAUDE_CONSTITUTION.md
    ├── SYSTEM_ARCHITECTURE.md
    ├── TECH_STACK.md
    ├── CLAUDE_WORKING_PROTOCOL.md
    ├── CURRENT_STATE.md
    ├── ADR/
    └── phases/
```

---

# 6. Протокол работы Claude Code

## Перед началом Phase
Claude обязан:
1. прочитать `CLAUDE_CONSTITUTION.md`, `SYSTEM_ARCHITECTURE.md`, `TECH_STACK.md`, `CLAUDE_WORKING_PROTOCOL.md`, `CURRENT_STATE.md` и файл текущего Phase;
2. проанализировать repository;
3. не предполагать, что файл или компонент существует;
4. проверить tests, migrations, dependencies, build и git status;
5. сначала написать краткий execution plan.

## Во время Phase
Claude обязан:
1. работать небольшими логическими блоками;
2. после критических изменений запускать tests;
3. не отключать failing tests ради зелёного результата;
4. не скрывать errors;
5. не добавлять ненужные зависимости;
6. не делать рефакторинг вне задачи без необходимости;
7. не переходить к следующему Phase;
8. не добавлять реальные секреты;
9. не выполнять опасные операции без approval;
10. сохранять архитектурную совместимость;
11. применять Feature Kill Gate к необязательному scope;
12. не строить будущие функции «на всякий случай»;
13. для authoritative data paths применять Retrieval Before Reasoning;
14. отмечать, какую бизнес-гипотезу или обязательную инфраструктурную потребность обслуживает новая функциональность.

## После Phase
Claude создаёт Phase Report:

```text
PHASE REPORT

Phase:
Status: PASS / PARTIAL / FAILED

Implemented:
- ...

Files created:
- ...

Files modified:
- ...

Database migrations:
- ...

Tests added:
- ...

Test results:
- ...

Security implications:
- ...

Cost implications:
- ...

Known limitations:
- ...

Technical debt:
- ...

Architecture deviations:
- NONE / list

Scope decisions:
- implemented because ...
- deferred because ...

Business hypothesis enabled by this phase:
- ...

Authoritative data paths verified:
- ...

Ready for next phase:
YES / NO
```

После отчёта обновить `docs/CURRENT_STATE.md` и остановиться.

---

# 7. Полная карта реализации

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

---

# 7.1 Fast Commercial Validation Protocol

Этот протокол применяется после того, как соответствующие Phase реализованы. Он определяет, как ROI Dealer должен быстро переводить Opportunity в рыночную проверку.

## Step A — Confirm the pain
Не строить продукт из одной идеи. Нужны Evidence и понятный ICP.

Выход:
```text
Pain Card + Evidence + Target ICP + Desired Outcome
```

## Step B — Create five hypotheses
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

## Step C — Select the smallest testable product
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

## Step D — Build under an Experiment Build Budget
До начала сборки зафиксировать:
- max money;
- max AI/API cost;
- max human time;
- max calendar time;
- expected evidence produced;
- kill criteria.

## Step E — Internal QA and Retrieval Check
До внешних пользователей:
1. critical flows проходят;
2. authoritative data извлекаются из DB/tool, а не prompt memory;
3. analytics events записываются;
4. secrets не находятся на клиенте;
5. cost limits работают;
6. rollback/recovery существует.

## Step F — Early User Crash Test
Небольшая группа реальных пользователей проходит продукт без подсказок автора.

Цель — найти не косметические замечания, а blocking defects и несоответствие mental model пользователя.

## Step G — Public Market Test
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

## Step H — Learn before expanding scope
После теста возможны только четыре базовых решения:

```text
SCALE
IMPROVE
PIVOT
KILL
```

Новые функции не добавлять автоматически. Сначала обновить Company Brain, Evidence, Experiment Result и Unit Economics.

---

# 7.2 Public Validation Release Gate

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

# 7.3 Authoritative Question Protocol

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

---

# 8. PHASE 00 — Project Bootstrap

Ниже находится инструкция, которую можно передать Claude Code как самостоятельное задание.

## ROI DEALER — IMPLEMENTATION PHASE 00

### ROLE
Ты — implementation agent проекта ROI Dealer.

Твоя задача — создать только инженерный фундамент проекта.

На этом Phase запрещено реализовывать:
- бизнес-логику;
- AI agents;
- judges;
- Telegram business UI;
- opportunity scoring;
- experiments;
- payments;
- Reward calculations;
- Media Factory;
- CRM.

Ты строишь основу, на которой будут безопасно выполняться последующие Phase.

### OBJECTIVE
Создать воспроизводимый TypeScript monorepo проекта ROI Dealer с:
- согласованной структурой каталогов;
- базовыми приложениями;
- общими пакетами;
- TypeScript configuration;
- dependency management;
- linting;
- formatting;
- testing;
- local Docker development infrastructure;
- environment configuration pattern;
- базовой CI;
- health-check skeleton;
- документацией;
- Architecture Decision Records directory;
- Phase state tracking.

Результат должен позволять следующему Phase добавлять доменную модель без перестройки фундамента.

### BUSINESS PURPOSE
ROI Dealer будет многоэтапной AI-операционной системой. Repository должен поддерживать несколько приложений, reusable packages, domain isolation, workers, API, Telegram Mini App, future bot, durable workflows, tests, infrastructure, documentation и controlled AI implementation phases.

Главная цель Phase 00 — исключить архитектурный хаос в дальнейшей AI-разработке и подготовить фундамент для быстрых, маленьких, проверяемых коммерческих экспериментов без нарушения security/source-of-truth дисциплины.

### REQUIRED INPUT DOCUMENTS
Перед началом прочитать:
1. `docs/CLAUDE_CONSTITUTION.md`
2. `docs/SYSTEM_ARCHITECTURE.md`
3. `docs/TECH_STACK.md`
4. `docs/CLAUDE_WORKING_PROTOCOL.md`
5. `docs/CURRENT_STATE.md`
6. `docs/phases/00_project_bootstrap.md`

Если файлов ещё нет, создать их на основе текущей спецификации Phase 00.

### HARD CONSTRAINTS
Нельзя:
1. менять технологический стек;
2. использовать MongoDB вместо PostgreSQL;
3. переносить backend на Python;
4. использовать n8n как core orchestrator;
5. добавлять business logic;
6. подключать реальные AI providers;
7. подключать реальные payment providers;
8. хранить реальные credentials;
9. создавать production cloud resources без отдельного approval;
10. переходить к PHASE 01.

Если возникает объективная причина нарушить ограничение — создать ADR proposal, остановиться и запросить approval.

### TASK 00.1 — Repository inspection
Если repository уже существует:
1. вывести текущую структуру;
2. проверить git status;
3. проверить package managers;
4. проверить configs;
5. не удалять существующий код без причины.

Если repository пуст — перейти к созданию monorepo.

### TASK 00.2 — Monorepo foundation
Создать monorepo. Предпочтительный package manager: `pnpm`.

Создать:
```text
apps/
packages/
workflows/
database/
infra/
tests/
docs/
```

Создать root `package.json` и scripts:
```text
build
dev
test
test:unit
test:integration
lint
format
typecheck
```

Все scripts должны реально выполняться.

### TASK 00.3 — Applications skeleton
Создать:
```text
apps/api
apps/worker
apps/miniapp
apps/bot
```

#### api
Минимальный TypeScript server skeleton.

Endpoint:
```text
GET /health
```

Ответ:
```json
{
  "status": "ok",
  "service": "api"
}
```

Без business logic.

#### worker
Минимальный worker process:
- startup;
- graceful shutdown;
- structured log;
- никаких real workflows.

#### miniapp
React + TypeScript skeleton:
- bootable application;
- placeholder screen;
- no Telegram business integration yet.

#### bot
Только skeleton. Не подключать Telegram token.

### TASK 00.4 — Packages skeleton
Создать:
```text
packages/domain
packages/schemas
packages/events
packages/policies
packages/agents
packages/judges
packages/skills
packages/ai-runtime
packages/economics
packages/rewards
packages/observability
packages/shared
```

Для каждого package:
- package metadata;
- TypeScript config;
- minimal export surface;
- README с назначением.

Не реализовывать доменные сущности или AI logic.

### TASK 00.5 — Workflow directories
Создать:
```text
workflows/discovery
workflows/opportunity
workflows/validation
workflows/solution
workflows/reward
workflows/improvement
```

Не реализовывать Temporal workflows. Только структура и README.

### TASK 00.6 — TypeScript configuration
Создать root и shared TypeScript configs.

Требования:
- strict mode;
- no implicit any;
- consistent module resolution;
- source maps;
- path aliases только если не создают скрытую связанность.

Не отключать strict mode ради удобства.

### TASK 00.7 — Formatting and linting
Настроить ESLint и Prettier.

Требования:
- единый root config;
- scripts работают для monorepo;
- generated folders исключены;
- lint errors падают в CI.

### TASK 00.8 — Test framework
Предпочтительно использовать Vitest.

Создать:
- unit test skeleton;
- integration test skeleton.

Добавить минимум:
1. health endpoint test;
2. simple shared package import test.

Tests выполняются из root.

### TASK 00.9 — Local development infrastructure
Создать Docker Compose.

На Phase 00 обязателен:
```text
postgres
```

PostgreSQL должен иметь:
- dev database;
- non-production credentials;
- health check;
- volume.

Можно подготовить placeholders для Temporal/object storage, но не добавлять ненужные работающие сервисы без необходимости.

### TASK 00.10 — Environment configuration
Создать `.env.example` только с безопасными placeholders.

Например:
```text
NODE_ENV=
API_PORT=
DATABASE_URL=
LOG_LEVEL=
```

Реальный `.env` обязан быть в `.gitignore`.

Создать config validation skeleton.

### TASK 00.11 — Structured logging
Добавить базовый structured logger.

Каждая запись должна поддерживать:
```text
timestamp
level
service
message
correlation_id
```

`correlation_id` на Phase 00 может быть optional.

Не использовать хаотические `console.log` как production pattern.

### TASK 00.12 — Graceful shutdown
API и worker должны корректно обрабатывать shutdown signals.

Подготовить фундамент для будущего закрытия DB connections и worker tasks.

### TASK 00.13 — Health infrastructure
Добавить `GET /health`.

Архитектура должна позволить позже расширить health checks на:
```text
database
temporal
storage
AI providers
```

### TASK 00.14 — Documentation foundation
Создать:
```text
docs/CLAUDE_CONSTITUTION.md
docs/SYSTEM_ARCHITECTURE.md
docs/TECH_STACK.md
docs/CLAUDE_WORKING_PROTOCOL.md
docs/CURRENT_STATE.md
docs/ADR/
docs/phases/
```

Создать `docs/ADR/README.md` и ADR template:
```text
Title
Status
Context
Decision
Alternatives
Consequences
Rollback
Date
Approved by
```

### TASK 00.15 — Current State file
Создать `docs/CURRENT_STATE.md`.

После PHASE 00 он должен содержать:
```text
Current Phase: 00
Phase Status: PASS / PARTIAL / FAILED

Implemented:
...

Not Implemented:
...

Applications:
...

Packages:
...

Infrastructure:
...

Tests:
...

Known Issues:
...

Next Allowed Phase:
01 only after owner approval
```

### TASK 00.16 — CI skeleton
На каждом commit / PR:
1. install dependencies;
2. typecheck;
3. lint;
4. unit tests;
5. build.

Deployment не добавлять.

### TASK 00.17 — Git hygiene
Проверить `.gitignore`.

Обязательно исключить:
```text
.env
.env.*
node_modules
dist
build
coverage
local volumes
IDE temporary files
OS temporary files
secret files
```

Но сохранить `.env.example`.

### TASK 00.18 — Root documentation
Создать root `README.md`.

Он должен объяснять:
1. что такое ROI Dealer;
2. текущую фазу разработки;
3. prerequisites;
4. install;
5. local start;
6. tests;
7. build;
8. repository structure;
9. где architecture documentation;
10. правило: не переходить на следующий Phase без approval.

### EXPECTED DIRECTORY RESULT
После Phase 00 структура должна быть близка к:

```text
roi-dealer/
├── apps/
│   ├── api/
│   ├── worker/
│   ├── miniapp/
│   └── bot/
├── packages/
│   ├── domain/
│   ├── schemas/
│   ├── events/
│   ├── policies/
│   ├── agents/
│   ├── judges/
│   ├── skills/
│   ├── ai-runtime/
│   ├── economics/
│   ├── rewards/
│   ├── observability/
│   └── shared/
├── workflows/
│   ├── discovery/
│   ├── opportunity/
│   ├── validation/
│   ├── solution/
│   ├── reward/
│   └── improvement/
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── docs/
├── infra/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── docs/
│   ├── ADR/
│   ├── phases/
│   ├── CLAUDE_CONSTITUTION.md
│   ├── SYSTEM_ARCHITECTURE.md
│   ├── TECH_STACK.md
│   ├── CLAUDE_WORKING_PROTOCOL.md
│   └── CURRENT_STATE.md
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

Допустимы технически обоснованные небольшие отличия.

### TEST REQUIREMENTS
Обязательно выполнить:
```text
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Проверить:
1. API запускается.
2. `/health` отвечает.
3. worker запускается и корректно завершается.
4. miniapp запускается.
5. packages импортируются.
6. Docker PostgreSQL запускается.
7. repository не содержит secret values.

### SECURITY CHECKLIST
Перед завершением Phase убедиться:
- [ ] нет API keys;
- [ ] нет Telegram token;
- [ ] нет cloud credentials;
- [ ] `.env` игнорируется;
- [ ] `.env.example` безопасен;
- [ ] production secrets не симулируются реальными значениями;
- [ ] нет root/full-system permissions для будущих agents;
- [ ] dependency set минимален;
- [ ] нет неизвестных postinstall scripts без необходимости.

### ACCEPTANCE CRITERIA
PHASE 00 получает PASS только если:
1. monorepo воспроизводимо устанавливается;
2. TypeScript strict mode работает;
3. все приложения собираются;
4. API health endpoint работает;
5. worker запускается;
6. miniapp запускается;
7. lint проходит;
8. tests проходят;
9. build проходит;
10. local PostgreSQL container запускается;
11. `.env.example` присутствует;
12. реальные secrets отсутствуют;
13. documentation foundation создан;
14. `CURRENT_STATE.md` обновлён;
15. CI config создан;
16. Claude не реализовал бизнес-логику следующих Phase.

### DEFINITION OF DONE
Phase 00 завершён, если новая Claude Code session может:

```text
clone repository
→ install dependencies
→ start local infrastructure
→ run applications
→ run tests
→ read architecture
→ понять текущий state
→ безопасно приступить к PHASE 01
```

без реконструкции repository.

### REQUIRED PHASE REPORT
После реализации вывести:

```text
PHASE 00 REPORT

Status:

Repository:
...

Applications:
...

Packages:
...

Infrastructure:
...

Tests:
...

Security:
...

Files created:
...

Files modified:
...

Architecture deviations:
...

Known limitations:
...

Technical debt:
...

Ready for PHASE 01:
YES / NO
```

Если `YES`, это не означает автоматический переход.

### STOP CONDITION
После формирования PHASE 00 REPORT:

**STOP.**

Не реализовывать PHASE 01. Ожидать явного approval владельца.

---

# 9. Что владелец проверяет после PHASE 00

1. Claude сообщил `PASS`, а не скрытый `PARTIAL`.
2. Tests действительно запускались.
3. Нет failing tests.
4. `/health` работает.
5. Mini App запускается.
6. PostgreSQL поднимается локально.
7. В repository нет API keys.
8. `CURRENT_STATE.md` создан.
9. Claude не начал PHASE 01.
10. Все architecture files существуют.

Если что-то не выполнено, PHASE 00 не считается завершённым.

---

# 10. Как продолжать после PHASE 00

```text
Owner approves Phase 00
↓
Claude receives PHASE 01 only
↓
Claude implements Core Domain
↓
Tests
↓
Phase Report
↓
STOP
↓
Owner review
↓
PHASE 02
```

Это правило сохраняется для всех Phase.

---

# 11. Definition of Done ROI CORE v0.1

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

## 11.1 Definition of Done — First Commercial Loop

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

# 12. Главная установка Claude Code

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

---

# END OF IMPLEMENTATION PLAYBOOK v1.1
