# ROI Dealer

**ROI Dealer** — AI-операционная система, которая находит реальные проблемы и рыночные возможности, собирает доказательства, формирует Opportunity, проверяет её пятью гипотезами и экспериментами, получает реальные рыночные сигналы и деньги, измеряет Customer Outcome, рассчитывает Contribution и Reward и сохраняет знания для следующих циклов.

```text
Source → Evidence → Signal → Pain → Opportunity → Business Model → 5 Hypotheses → Experiments
→ Customer / Revenue → Solution → Product → Customer Outcome → Reward → Knowledge / Skill / Asset
→ Company Brain ↺
```

> AI думает. Backend проверяет. PostgreSQL хранит authoritative state. Event History хранит историю.
> Temporal выполняет долгие workflows. Company Brain хранит знания. Владелец принимает стратегические решения.

## Текущая фаза

Актуальная фаза, её статус и что разрешено дальше — [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md); план — [`docs/ROADMAP.md`](docs/ROADMAP.md).

> ⚠️ **Правило:** следующая Phase начинается **только после явного approval владельца**.

## Prerequisites

- Node.js **22 LTS** (`>=22.12`, см. `.nvmrc`)
- pnpm **10** (`corepack enable` подхватит версию из `packageManager`)
- Docker с Docker Compose v2 — для локального PostgreSQL

## Install

```bash
pnpm install
cp .env.example .env   # опционально: значения по умолчанию подходят для локальной разработки
```

## Local start

```bash
pnpm infra:up     # PostgreSQL 18 на 127.0.0.1:5432 (ждёт healthy)
pnpm db:migrate   # применить миграции к DATABASE_URL из .env (cp .env.example .env)
pnpm dev          # api (:3000), worker, miniapp (:5173) в watch-режиме (бот — отдельно, см. ниже)

curl http://127.0.0.1:3000/health
# {"status":"ok","service":"api"}
```

Отдельные приложения:

```bash
pnpm --filter @roi-dealer/api dev
pnpm --filter @roi-dealer/worker dev
pnpm --filter @roi-dealer/miniapp dev
pnpm dev:bot   # бот-пульт; нужен .env с TELEGRAM_* (используйте отдельного тестового бота)
```

Остановить инфраструктуру: `pnpm infra:down`.

## Tests

```bash
pnpm test               # unit + integration
pnpm test:unit          # in-process, без сокетов и процессов
pnpm test:integration   # реальные HTTP-сокеты, OS-процессы и PostgreSQL
```

Integration-тестам нужен PostgreSQL: `pnpm infra:up` (или `TEST_DATABASE_URL`). Каждый файл тестов создаёт свою временную БД и удаляет её в конце.

## Build and checks

```bash
pnpm typecheck      # tsc -b по всем проектам (strict)
pnpm lint           # ESLint, 0 warnings
pnpm format:check   # Prettier (pnpm format — исправить)
pnpm build          # tsc -b + vite build (miniapp)
```

CI (`.github/workflows/ci.yml`) на каждый push и PR: install → typecheck → lint → format check → unit tests → build → миграции → integration tests (с сервисом PostgreSQL 18).

Miniapp после зелёного CI в default branch публикуется на GitHub Pages: https://userpr0.github.io/roi-dealer/ ([ADR-0002](docs/ADR/0002-miniapp-hosting-github-pages.md)).

## Repository structure

```text
apps/
  api/          HTTP API: GET /health (с проверкой БД, если задан DATABASE_URL)
  worker/       фоновый процесс — PHASE 00: lifecycle, graceful shutdown
  miniapp/      Telegram Mini App (React + Vite) — PHASE 00: placeholder
  bot/          бот-пульт владельца в Telegram (фаза 13a): /status, уведомления, Docker-образ
packages/
  shared/         config validation (Zod), graceful shutdown
  telegram/       Telegram Bot API: клиент, long polling, команды только для владельца
  observability/  structured logger, health registry, correlation id
  domain/         сущности, жизненные циклы и правила ROI CORE v0.1 (PHASE 01)
  schemas/        строгие входные контракты (PHASE 01)
  database/       PostgreSQL: подключение, миграции, репозитории (PHASE 02)
  events/ policies/ agents/ judges/ skills/
  ai-runtime/ economics/ rewards/          placeholders следующих Phase
workflows/      Temporal workflows (PHASE 00: только README)
database/       migrations/ (SQL), docs/schema.md
infra/          docker/compose.yaml — локальный PostgreSQL
tests/          unit/, integration/, e2e/, fixtures/, support/
docs/           архитектура, конституция, протокол, состояние, ADR, phases, playbook
```

## Architecture documentation

| Документ                                                             | Содержание                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`docs/CLAUDE_CONSTITUTION.md`](docs/CLAUDE_CONSTITUTION.md)         | Неизменяемые правила (source of truth, append-only history, human gates, security…)  |
| [`docs/SYSTEM_ARCHITECTURE.md`](docs/SYSTEM_ARCHITECTURE.md)         | Цели, системы организма, архитектура реализации, карта Phase, коммерческие протоколы |
| [`docs/TECH_STACK.md`](docs/TECH_STACK.md)                           | Канонический стек и конкретные инструменты / версии                                  |
| [`docs/CLAUDE_WORKING_PROTOCOL.md`](docs/CLAUDE_WORKING_PROTOCOL.md) | Как ведётся работа по Phase, отчёты, проверки                                        |
| [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md)                     | Текущая Phase и её статус                                                            |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)                                 | Что собрано и путь к рабочему состоянию                                              |
| [`docs/ADR/`](docs/ADR/README.md)                                    | Architecture Decision Records                                                        |
| [`docs/phases/`](docs/phases/README.md)                              | Спецификации и отчёты Phase                                                          |
| [`docs/deploy/`](docs/deploy/telegram-bot.md)                        | Развёртывание бота-пульта и БД в облаке                                              |
| [`docs/runbooks/`](docs/runbooks/README.md)                          | Инструкции на аварии                                                                 |
| [`docs/playbook/`](docs/playbook/IMPLEMENTATION_PLAYBOOK_v1.1.md)    | Implementation Playbook v1.1 — исходная спецификация                                 |

## Security

- Реальные секреты никогда не хранятся в repository. `.env` игнорируется git; `.env.example` содержит только безопасные локальные значения.
- В production секреты берутся из managed Secret Manager / Vault.
- Архитектурные изменения — только через ADR с approval владельца.
