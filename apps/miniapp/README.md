# @roi-dealer/miniapp

Owner Command Center — Telegram Mini App (React + TypeScript + Vite). **PHASE 13:** одна страница с данными пульта из `GET /api/panel` ([ADR-0008](../../docs/ADR/0008-miniapp-data-through-api.md)):

- стоп-кран;
- сколько ждёт решения;
- деньги месяца с полосками лимитов, AI за день, бюджеты тестов, выручка и ROI;
- незавершённые тесты: день, метрика, траты против бюджета и stop-loss;
- поток цикла за 30 дней и за всё время, время от сигнала до решения, новые знания.

Только просмотр: решения остаются кнопками в боте. Без библиотек графиков.

```bash
pnpm --filter @roi-dealer/miniapp dev       # http://127.0.0.1:5173
pnpm --filter @roi-dealer/miniapp build     # dist/
pnpm --filter @roi-dealer/miniapp preview   # http://127.0.0.1:4173
```

## Данные

- **Адрес `api`** — параметр `?api=` в адресе страницы (`apiAddress`). Его ставит бот в кнопку меню «Пульт» из своего `PUBLIC_API_URL` ([ADR-0008, поправка](../../docs/ADR/0008-miniapp-data-through-api.md#поправка-2026-10-19-адрес-api-из-кнопки-меню-d-023)). Принимается только `https` с обычным именем хоста, без логина, query и фрагмента. Переменная сборки `VITE_API_URL` (переменная репозитория `MINIAPP_API_URL`) необязательна и главнее параметра. Без адреса Mini App пишет, что адрес API не задан.
- **Подпись** — `window.Telegram.WebApp.initData` из официального скрипта `telegram-web-app.js` уходит в заголовке `Authorization: tma <initData>`. Вне Telegram подписи нет — Mini App просит открыть пульт из бота.
- **Секретов в сборке нет** (Public Validation Release Gate, playbook §7.2): только адрес `api`.

## Публикация

После зелёного CI в default branch workflow `.github/workflows/miniapp-pages.yml` собирает приложение и публикует его на GitHub Pages: https://userpr0.github.io/roi-dealer/ ([ADR-0002](../../docs/ADR/0002-miniapp-hosting-github-pages.md)).

Базовый путь задаётся переменной `MINIAPP_BASE_PATH` (по умолчанию `/`):

```bash
MINIAPP_BASE_PATH=/roi-dealer/ VITE_API_URL=https://api.example pnpm --filter @roi-dealer/miniapp build
```

Подключение к боту — само: с `PUBLIC_API_URL` бот ставит кнопку «Пульт» в чате владельца (`setChatMenuButton`, адрес — `MINIAPP_URL` бота). @BotFather не нужен.
