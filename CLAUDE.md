# ROI Dealer — instructions for Claude Code

This repository is built phase by phase under an owner-approval protocol. Before doing anything:

1. Read `docs/CURRENT_STATE.md` — the current phase, its status and what is allowed next.
2. Read `docs/CLAUDE_CONSTITUTION.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/TECH_STACK.md`, `docs/CLAUDE_WORKING_PROTOCOL.md` and the current phase file in `docs/phases/` — including its requirements file `docs/phases/NN_*.plan.md` if one exists (owner requirements recorded ahead of the phase must go into the phase spec).

## Non-negotiable rules

- **Never start a phase without explicit owner approval.** Finish a phase with a Phase Report and update `docs/CURRENT_STATE.md`. An approval may cover several phases: under D-020 every phase up to full Level 2 is approved in the order of `docs/ROADMAP.md`, so continue to the next approved phase and stop only when the owner must act (merge a PR, Railway, API keys, test bot), a decision changes the stack or adds a paid service beyond the plan (ADR), money exceeds the D-007 limits, or Level 3 (payments, ads, legal) begins.
- **No silent architecture changes.** If a stack or architecture decision should change: write an ADR proposal in `docs/ADR/`, explain reason, impact and alternatives, and stop for approval.
- **Never commit secrets.** `.env` is git-ignored; `.env.example` holds safe local placeholders only.
- **Do not disable or skip failing tests.** Report failures as they are.
- **Abstract the pattern, do not copy the artifact** (constitution §2.20): check rights first (audio separately from video), store structured parameters, never publish copied material.
- **Permitted access only** (§2.21): official APIs and allowed plans; no multi-accounting, anti-detect or limit circumvention.
- **No business logic ahead of its phase.** Placeholder packages stay placeholders until their phase is approved.
- Apply the Feature Kill Gate (constitution §2.15) to optional scope; no "just in case" features.

## Commands (run from the repository root)

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # tsc -b (strict, project references)
pnpm lint             # ESLint, zero warnings
pnpm format:check     # Prettier
pnpm test             # Vitest: unit + integration
pnpm build
pnpm infra:up         # local PostgreSQL 18 (Docker); integration tests need it
pnpm db:migrate       # apply database/migrations to DATABASE_URL
pnpm dev:bot          # owner bot; needs TELEGRAM_* in .env — use a separate test bot locally
```

## Code conventions

- Log only through `createLogger` from `@roi-dealer/observability`; `console.*` is a lint error.
- Read configuration only through `loadConfig(schema, process.env)` from `@roi-dealer/shared` with a Zod schema.
- Register resource cleanup with the `ShutdownManager`; register dependency health checks with the `HealthRegistry`.
- Keep `apps/*` thin; put logic into `packages/*`. Packages never import apps.
- Workspace packages resolve to `src/` via the `@roi-dealer/source` export condition in dev and tests, and to `dist/` at runtime. Do not add tsconfig `paths` aliases.
- Tests live in the root `tests/` directory: `unit/` (in-process), `integration/` (real sockets and processes).
- Access PostgreSQL only through `@roi-dealer/database` (repositories, `database.transaction`). Change the schema only with a new file in `database/migrations/`; never edit an applied migration.
- Every repository write appends its event (Event History). Store an entity at version 1, then every new version with `update(entity, actor)` using the actor of the domain transition. Pass the request's `correlationId` to `database.transaction`; run owner actions from buttons through `database.command` with an idempotency key.
- Change entity state only through `@roi-dealer/domain` functions (factories and transitions), never by assigning fields; validate untrusted input with `parseInput` from `@roi-dealer/schemas` first. Only the `owner` actor makes decisions; AI agents only propose.
- Follow the owner decisions in `docs/OWNER_DECISIONS.md` (USD accounting, $20 approval threshold, budgets, markets).
- Call the Telegram Bot API only through `@roi-dealer/telegram`. Any state-changing command or button must ask the owner for confirmation first and run as an idempotent `database.command` (key `tg-callback-<id>`, correlation `tg-update-<id>`). Never log the bot token or message text.
- Owner command center logic lives in `@roi-dealer/command-center`; `apps/bot` only wires it. Every panel command and button declares its permission and is recorded in the access log.
- Access (PHASE 04): roles and permissions live in `@roi-dealer/policies`; repositories check every write against them. Members, agents and integrations write only through an active `Principal`; give a new one access with `requestAccess` (owner approves in `/decisions`), never by inserting an active principal. Build the actor only from an authenticated channel, never from input. AI never changes permissions.
- Evidence (PHASE 05): add a source only as a `SOURCE_CATALOG` entry in `@roi-dealer/evidence` with checked terms and verdict `allowed` — terms first, connector code second. Collect only through `collectEvidence` (kill switch, catalog, active integration principal) and redact with `redactPersonalData` before anything is stored. Never request or store authors, profiles or raw responses; keep excerpts short (`MAX_EXCERPT_LENGTH`). External APIs in tests are local fakes (`tests/support/fake-*.ts`).
- Signals & Pain (PHASE 06): pains come only from `analyzeEvidence` in `@roi-dealer/signals`, run as the `pain-analyst` agent with its granted principal. Keep a signal only when `toSignalDraft` confirms its quote is in the Evidence text; group with `closestPains` + `match-pain`; change pains only through `addSignalToPain` / `validatePain`. Every Evidence is recorded once in `signal_extractions`.
- Opportunities (PHASE 07): drafts come only from `assessPains` in `@roi-dealer/opportunities`, run as the `opportunity-analyst` agent. Count only money quotes `verifiedQuotes` finds in the Evidence; compute the score with `scoreOpportunity` and the model with `routeBusinessModel` in code — never take numbers from the AI (§2.13). Every pain version is recorded once in `opportunity_assessments`; only the owner decides on opportunities.
- Company Brain (PHASE 08): search and answers come only from the fixed parameterized queries of `database.brain`; user text is a parameter or reduced to letters and digits (`anyWordsQuery`), never SQL. `/ask` answers with numbers from the database and their source, no AI. A new searchable table needs a GIN expression index in a migration and the identical expression in its query. Eval reports (tag `eval`) stay out of search and counts.
- AI (PHASE 09, ADR-0006, D-021): call models only through `runTask` from `@roi-dealer/ai-runtime`; provider SDKs never leave its adapters. A new AI task is an `AiTask` in `AI_TASKS` with Zod input and output, a golden set of ≥ 20 cases with a score, `maxCostMicroUsd` covering the worst call and a `dailyShare` (all shares plus evals ≤ 1). A changed prompt is a new `version`. Code applies what the model proposes. Never log or store prompts, outputs or keys; tests use the local fakes in `tests/support/fake-ai.ts`.
- Kill switch: every automation and automated spend calls `assertAutomationRunning` (from `@roi-dealer/domain`, with the `automation` SystemControl loaded from the database) as its first step.
- Code and comments are in English; project documentation is in Russian.
