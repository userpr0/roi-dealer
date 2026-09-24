# @roi-dealer/bot

Бот-пульт владельца ROI Dealer (фаза 13a, [ADR-0003](../../docs/ADR/0003-early-telegram-owner-bot.md)).

- Отвечает **только** владельцу (`TELEGRAM_OWNER_USER_ID`) и только в личном чате.
- Команды (только чтение): `/start`, `/status` — здоровье, версия, окружение, время работы; `/help`.
- Уведомляет владельца о запуске и остановке.
- Кнопка меню «Пульт» открывает Mini App (настраивается в @BotFather, [ADR-0002](../../docs/ADR/0002-miniapp-hosting-github-pages.md)).

## Конфигурация

| Переменная               | Обязательна | По умолчанию               |
| ------------------------ | ----------- | -------------------------- |
| `TELEGRAM_BOT_TOKEN`     | да          | — (секрет, из @BotFather)  |
| `TELEGRAM_OWNER_USER_ID` | да          | — (ваш Id из @userinfobot) |
| `TELEGRAM_API_BASE_URL`  | нет         | `https://api.telegram.org` |
| `APP_VERSION`            | нет         | `dev`                      |
| `NODE_ENV`               | нет         | `development`              |
| `LOG_LEVEL`              | нет         | `info`                     |

## Запуск

```bash
pnpm dev:bot                                  # локально, читает .env (используйте ОТДЕЛЬНОГО тестового бота)
docker build -f apps/bot/Dockerfile -t roi-dealer-bot .   # образ для облака
```

Развёртывание в облаке — [`docs/deploy/telegram-bot.md`](../../docs/deploy/telegram-bot.md).

## Структура

- `src/config.ts` — Zod-схема конфигурации.
- `src/commands.ts` — команды и тексты для владельца.
- `src/main.ts` — сборка процесса: config → logger → shutdown (8 s) → Telegram client → команды → long polling → уведомления.
- `Dockerfile` — multi-stage образ: сборка в pnpm workspace, в runtime только `dist` и production-зависимости, пользователь `node`.
