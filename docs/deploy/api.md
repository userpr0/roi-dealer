# API в облаке (Railway): данные для Mini App

> **Когда:** после вливания PR с PHASE 13, когда бот и база уже работают ([telegram-bot.md](telegram-bot.md), [database.md](database.md)).
> **Что делает `api`:** отдаёт пульту в Telegram (Mini App) снимок: решения, деньги месяца, тесты и статистику цикла. Только владельцу и только после проверки подписи Telegram ([ADR-0008](../ADR/0008-miniapp-data-through-api.md)). Ничего не меняет: решения остаются кнопками в боте.
> Без `api` всё работает, Mini App просто пишет, что данные не подключены.
> Интерфейс Railway меняется: если кнопка называется иначе, ищите ближайшую по смыслу.

## Сколько стоит

`api` почти всё время ждёт запросов: обычно $1–3 в месяц. Вместе с ботом, worker и базой — в пределах лимита инфраструктуры $20/мес (D-007). Счёт Railway вносите через `/cost`.

## 1. Создать сервис (около 7 минут)

1. [railway.com/dashboard](https://railway.com/dashboard) → проект с ботом → **+ Create** → **GitHub Repo** → `userpr0/roi-dealer`.
2. Если Railway создал несколько **новых** сервисов, оставьте один (он станет `api`), остальные новые удалите: сервис → **Settings** → внизу **Delete Service**. Бот и worker с зелёным **Online** не трогайте.
3. Новый сервис → **Settings** → вверху имя → `api`.
4. **Variables** → **Raw Editor** → две строки → **Update Variables**:

   ```
   RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

5. Ещё две переменные — **ссылками на переменные бота**, чтобы токен не копировать руками:
   1. **Variables** → **+ New Variable** → имя `TELEGRAM_BOT_TOKEN`.
   2. В поле значения наберите `${{` и выберите в подсказке сервис бота → `TELEGRAM_BOT_TOKEN` → **Add**.
   3. Так же — `TELEGRAM_OWNER_USER_ID` со ссылкой на `TELEGRAM_OWNER_USER_ID` бота.

   Токен нужен `api` только для проверки подписи Telegram: `api` не пишет в Telegram и не логирует токен.

6. **Settings**:

   | Раздел     | Поле                           | Значение                                        |
   | ---------- | ------------------------------ | ----------------------------------------------- |
   | Source     | Root Directory                 | пусто                                           |
   | Source     | Branch connected to production | `main`                                          |
   | Source     | Wait for CI                    | включено                                        |
   | Build      | Builder                        | Dockerfile (задаётся `RAILWAY_DOCKERFILE_PATH`) |
   | Build      | Custom Build Command           | пусто                                           |
   | Build      | Watch Paths                    | пусто                                           |
   | Deploy     | Pre-deploy Command             | пусто — миграции запускают бот и worker         |
   | Deploy     | Custom Start Command           | **пусто**                                       |
   | Deploy     | Healthcheck Path               | `/health`                                       |
   | Deploy     | Serverless                     | выключено                                       |
   | Scale      | Replicas                       | 1                                               |
   | Scale      | Replica Limits                 | 0.5 vCPU, 0.5 GB — защита бюджета               |
   | Networking | Public domain                  | **Generate Domain**, порт `8080`                |

7. Вверху **Apply N changes** → **Deploy**. Через 2–4 минуты карточка `api` станет **Online**.
8. Скопируйте адрес из **Networking** (вида `https://api-production-xxxx.up.railway.app`). Это не секрет.

## 2. Подключить Mini App к `api` (около 3 минут)

1. GitHub → репозиторий → **Settings** → **Secrets and variables** → **Actions** → вкладка **Variables** → **New repository variable**:
   - **Name:** `MINIAPP_API_URL`;
   - **Value:** адрес из шага 1.8, без `/` в конце.

   Именно **Variables**, не Secrets: адрес попадает в публичную сборку Mini App.

2. **Actions** → **Deploy miniapp** → **Run workflow** → `main`. Или дождитесь следующего вливания в `main`: Mini App пересоберётся после зелёного CI.
3. Если кнопка Mini App в боте ещё не настроена: [@BotFather](https://t.me/BotFather) → `/mybots` → бот → **Bot Settings** → **Menu Button** → `https://userpr0.github.io/roi-dealer/`.

## 3. Проверка

| Где                               | Что должно быть                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Railway → `api` → **Deploy Logs** | `mini app panel` с `enabled: true`, затем `api listening` и `api started`          |
| Браузер: `<адрес>/health`         | `"status":"ok"`, в `checks` — `database` со `"status":"ok"`                        |
| Браузер: `<адрес>/api/panel`      | `401 {"error":"unauthorized"}` — без подписи Telegram данные не отдаются           |
| Telegram → кнопка меню бота       | Пульт: стоп-кран, «Ждут решения», деньги с полосками лимитов, тесты, цикл          |
| Telegram → `/access`              | Попытки открыть пульт с чужого аккаунта — в строке «Отклонённых попыток за 7 дней» |

## Если что-то не так

| Mini App пишет                    | Что значит и что сделать                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| «Адрес API не задан»              | Нет переменной `MINIAPP_API_URL` или Mini App ещё не пересобрана — шаг 2                                     |
| «Откройте пульт из бота»          | Страница открыта в браузере, а не в Telegram. Данные видны только из бота                                    |
| «Подпись Telegram не принята»     | У `api` другой токен, чем у бота, или пульт открыт больше суток назад. Проверьте ссылку `TELEGRAM_BOT_TOKEN` |
| «Пульт доступен только владельцу» | Открыт с другого аккаунта Telegram. Попытка записана в журнал доступа                                        |
| «Пульт ещё не подключён»          | У `api` нет `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` или `TELEGRAM_OWNER_USER_ID` — шаг 1.4–1.5                  |
| «API не отвечает»                 | Сервис `api` не **Online** или адрес в `MINIAPP_API_URL` неверный                                            |

Свой домен Mini App вместо `userpr0.github.io` — переменная `MINIAPP_ORIGINS` у `api` (адреса через запятую, `https://` без пути).

**Отключить:** удалить сервис `api` в Railway и переменную `MINIAPP_API_URL`. Бот и данные не пострадают.
