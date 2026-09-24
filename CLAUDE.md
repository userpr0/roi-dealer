# ROI Dealer — instructions for Claude Code

This repository is built phase by phase under an owner-approval protocol. Before doing anything:

1. Read `docs/CURRENT_STATE.md` — the current phase, its status and what is allowed next.
2. Read `docs/CLAUDE_CONSTITUTION.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/TECH_STACK.md`, `docs/CLAUDE_WORKING_PROTOCOL.md` and the current phase file in `docs/phases/`.

## Non-negotiable rules

- **Never start the next phase without explicit owner approval.** Finish a phase with a Phase Report, update `docs/CURRENT_STATE.md`, then stop.
- **No silent architecture changes.** If a stack or architecture decision should change: write an ADR proposal in `docs/ADR/`, explain reason, impact and alternatives, and stop for approval.
- **Never commit secrets.** `.env` is git-ignored; `.env.example` holds safe local placeholders only.
- **Do not disable or skip failing tests.** Report failures as they are.
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
pnpm infra:up         # local PostgreSQL 18 (Docker)
pnpm dev:bot          # owner bot; needs TELEGRAM_* in .env — use a separate test bot locally
```

## Code conventions

- Log only through `createLogger` from `@roi-dealer/observability`; `console.*` is a lint error.
- Read configuration only through `loadConfig(schema, process.env)` from `@roi-dealer/shared` with a Zod schema.
- Register resource cleanup with the `ShutdownManager`; register dependency health checks with the `HealthRegistry`.
- Keep `apps/*` thin; put logic into `packages/*`. Packages never import apps.
- Workspace packages resolve to `src/` via the `@roi-dealer/source` export condition in dev and tests, and to `dist/` at runtime. Do not add tsconfig `paths` aliases.
- Tests live in the root `tests/` directory: `unit/` (in-process), `integration/` (real sockets and processes).
- Change entity state only through `@roi-dealer/domain` functions (factories and transitions), never by assigning fields; validate untrusted input with `parseInput` from `@roi-dealer/schemas` first. Only the `owner` actor makes decisions; AI agents only propose.
- Follow the owner decisions in `docs/OWNER_DECISIONS.md` (USD accounting, $20 approval threshold, budgets, markets).
- Call the Telegram Bot API only through `@roi-dealer/telegram`. Bot commands are read-only; any state-changing command must ask the owner for confirmation first. Never log the bot token or message text.
- Code and comments are in English; project documentation is in Russian.
