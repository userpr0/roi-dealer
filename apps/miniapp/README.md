# @roi-dealer/miniapp

Owner Command Center — Telegram Mini App (React + TypeScript + Vite). **PHASE 00: placeholder-экран**, без Telegram SDK и без обращений к API.

```bash
pnpm --filter @roi-dealer/miniapp dev       # http://127.0.0.1:5173
pnpm --filter @roi-dealer/miniapp build     # dist/
pnpm --filter @roi-dealer/miniapp preview   # http://127.0.0.1:4173
```

## Публикация

После зелёного CI в default branch workflow `.github/workflows/miniapp-pages.yml` собирает приложение и публикует его на GitHub Pages: https://userpr0.github.io/roi-dealer/ ([ADR-0002](../../docs/ADR/0002-miniapp-hosting-github-pages.md)).

Базовый путь задаётся переменной `MINIAPP_BASE_PATH` (по умолчанию `/`):

```bash
MINIAPP_BASE_PATH=/roi-dealer/ pnpm --filter @roi-dealer/miniapp build
```

Подключение к боту: [@BotFather](https://t.me/BotFather) → `/mybots` → бот → **Bot Settings → Menu Button** → адрес выше.

Реализация — PHASE 13: approvals, risks, costs, decisions, health.
Правило: секреты никогда не попадают в client bundle (Public Validation Release Gate, playbook §7.2).
