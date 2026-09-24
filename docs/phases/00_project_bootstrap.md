# PHASE 00 — Project Bootstrap

> **Источник:** Implementation Playbook v1.1, §8 (перенесено дословно).
> **Статус выполнения:** см. [`docs/CURRENT_STATE.md`](../CURRENT_STATE.md) и [отчёт PHASE 00](00_project_bootstrap.report.md).

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
