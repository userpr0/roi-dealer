# ADR-0002: Хостинг miniapp на GitHub Pages

- **Status:** Accepted
- **Date:** 2026-09-24
- **Approved by:** владелец — прямой запрос в сессии 2026-09-24: «сделай сам — разместите miniapp по HTTPS»

## Context

Владелец хочет открыть Owner Command Center (`apps/miniapp`) в Telegram. Telegram открывает Mini App только по публичному HTTPS-адресу. TASK 00.16 запрещала добавлять deployment в PHASE 00; этот ADR фиксирует отступление по прямому запросу владельца.

Сейчас miniapp — статичный placeholder без данных, секретов и обращений к API.

## Decision

1. `apps/miniapp` собирается в статику и публикуется на **GitHub Pages**: `https://userpr0.github.io/roi-dealer/`.
2. Деплой выполняет `.github/workflows/miniapp-pages.yml`:
   - запускается **только после успешного CI** для push в default branch этого repository (fork-PR не деплоятся) или вручную (`workflow_dispatch`);
   - собирает с `MINIAPP_BASE_PATH=/<repo>/` и публикует через `actions/deploy-pages` (OIDC, без долгоживущих токенов).
3. В `vite.config.ts` базовый путь задаётся переменной `MINIAPP_BASE_PATH` (по умолчанию `/`).
4. Однократное ручное действие владельца: **Settings → Pages → Build and deployment → Source: GitHub Actions** (API для включения Pages у Claude нет).

## Alternatives

| Вариант                                          | Почему не выбран                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Cloudflare Pages / Netlify / Vercel              | Нужны аккаунт и API-токен владельца; в остальном равноценны. Переход — замена одного workflow |
| Туннель (cloudflared / ngrok) с локальной машины | Адрес временный, работает только пока включён компьютер                                       |
| claude.ai Artifact                               | Приватная ссылка: Telegram WebView не сможет её открыть                                       |
| Ждать PHASE 13                                   | Владелец хочет видеть пульт в Telegram уже сейчас                                             |

## Consequences

- **+** Бесплатно, HTTPS из коробки, без внешних аккаунтов и секретов; деплоится только то, что прошло CI.
- **−** Сайт публичный: любой может открыть страницу. Сейчас это только placeholder; далее bundle тоже будет публичным (так устроены все Mini Apps), поэтому **секреты никогда не попадают в miniapp**, а данные защищаются на стороне `api` (проверка Telegram `initData`, доступ только владельцу — PHASE 13).
- **−** Workflow `workflow_run` срабатывает, только если файл workflow лежит в default branch.
- Стоимость: $0 (GitHub Pages и Actions для публичного repository).

## Rollback

Удалить `.github/workflows/miniapp-pages.yml` и отключить Pages (Settings → Pages → Unpublish site). Кнопку Mini App в BotFather переключить на новый адрес или удалить. Данные не затрагиваются.
