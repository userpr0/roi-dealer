# Развёртывание бота-пульта в облаке

Бот — один Docker-контейнер (`apps/bot/Dockerfile`), который сам забирает сообщения у Telegram (long polling). Публичный адрес, домен и открытые порты **не нужны**.

> ⚠️ **Один токен — один работающий бот.** Если бот с тем же токеном запущен ещё где-то (например, `pnpm dev:bot` на ПК), Telegram отвечает ошибкой 409, и экземпляры мешают друг другу. Для локальных экспериментов создайте отдельного тестового бота в @BotFather.

## 1. Подготовьте два значения

| Переменная               | Где взять                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | [@BotFather](https://t.me/BotFather) → `/mybots` → ваш бот → **API Token**. Это секрет: не отправляйте его в чаты и не коммитьте.                     |
| `TELEGRAM_OWNER_USER_ID` | Напишите любое сообщение [@userinfobot](https://t.me/userinfobot) — он ответит вашим числовым `Id`. Бот будет отвечать **только** этому пользователю. |

Необязательные:

| Переменная    | По умолчанию | Назначение                                          |
| ------------- | ------------ | --------------------------------------------------- |
| `LOG_LEVEL`   | `info`       | `debug` — подробные логи                            |
| `APP_VERSION` | `dev`        | Версия в `/status` (например, короткий SHA коммита) |

## 2. Вариант A — Railway (рекомендуется, без командной строки)

Проверено на запуске 2026-09-25.

1. Зарегистрируйтесь на [railway.com](https://railway.com) через GitHub, тариф **Hobby** (около $5/мес). Сразу задайте лимиты: **Usage → Usage limits** — оповещение $15, жёсткий лимит $20 (D-007).
2. **New Project → Deploy from GitHub repo** → `userpr0/roi-dealer`. Доступ приложению Railway — **Only select repositories**.
3. Railway сам находит в монорепозитории все приложения и создаёт по сервису на каждое (`api`, `worker`, `miniapp`, `bot`). **Оставьте только `@roi-dealer/bot`**, остальные удалите: сервис → **Settings** → внизу **Delete Service**. Mini App работает на GitHub Pages, `api` и `worker` пока заготовки.
4. Сервис бота → **Variables** → **Raw Editor** (вкладка **ENV**) → три строки → **Update Variables**:
   ```
   RAILWAY_DOCKERFILE_PATH=apps/bot/Dockerfile
   TELEGRAM_BOT_TOKEN=<токен из п. 1>
   TELEGRAM_OWNER_USER_ID=<ваш Id>
   ```
   Блок **Suggested Variables** (его Railway собрал из `.env.example`) **не добавляйте**: там `NODE_ENV=development` и настройки других сервисов.
5. Сервис бота → **Settings**. Railway заранее прописывает команды для сборки без Docker, их нужно убрать:

   | Раздел     | Поле                           | Значение                                                                             |
   | ---------- | ------------------------------ | ------------------------------------------------------------------------------------ |
   | Source     | Root Directory                 | пусто                                                                                |
   | Source     | Branch connected to production | `main`                                                                               |
   | Source     | Wait for CI                    | включено — выкатываются только коммиты с зелёными проверками                         |
   | Build      | Builder                        | Dockerfile (задаётся переменной `RAILWAY_DOCKERFILE_PATH`)                           |
   | Build      | Custom Build Command           | пусто                                                                                |
   | Build      | Watch Paths                    | пусто, иначе изменения в `packages/*` не пересоберут бота                            |
   | Deploy     | Custom Start Command           | **пусто**, иначе вместо `CMD` из Dockerfile запустится `pnpm`, которого нет в образе |
   | Deploy     | Serverless                     | выключено — бот должен работать постоянно                                            |
   | Scale      | Replicas                       | 1 (два экземпляра с одним токеном конфликтуют)                                       |
   | Scale      | Replica Limits                 | 1 vCPU, 0.5 GB — защита бюджета при ошибке в коде                                    |
   | Networking | Public domain                  | не создавать                                                                         |

6. Вверху **Apply N changes → Deploy**. Через 2–4 минуты карточка станет **Online**, в Telegram придёт **«🟢 ROI Dealer bot запущен»**. Отправьте боту `/status`.

Дальше Railway сам пересобирает бота после каждого слияния в `main`, когда проверки GitHub зелёные.

## 3. Вариант B — любой сервер с Docker (VPS)

```bash
git clone https://github.com/userpr0/roi-dealer.git && cd roi-dealer
docker build -f apps/bot/Dockerfile --build-arg APP_VERSION=$(git rev-parse --short HEAD) -t roi-dealer-bot .

# Секреты — в файле с правами только для владельца, вне repository
install -m 600 /dev/null ~/roi-bot.env
nano ~/roi-bot.env   # TELEGRAM_BOT_TOKEN=...  TELEGRAM_OWNER_USER_ID=...

docker run -d --name roi-dealer-bot --restart unless-stopped --env-file ~/roi-bot.env roi-dealer-bot
docker logs -f roi-dealer-bot
```

Обновление: `git pull`, повторить `docker build`, затем `docker rm -f roi-dealer-bot` и снова `docker run …`.

## 4. Проверка

| Действие                          | Ожидаемый результат                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Деплой / перезапуск               | Сообщение «🟢 ROI Dealer bot запущен» с версией и окружением                         |
| `/status`                         | «🟢 ROI Dealer: ok», версия, окружение, время работы                                 |
| `/help`                           | Список команд                                                                        |
| Остановка сервиса                 | Сообщение «🔴 ROI Dealer bot остановлен»                                             |
| Сообщение боту с другого аккаунта | Бот молчит; в логах `telegram message rejected: sender is not the owner` с `user_id` |

## 5. Если что-то не так

| Симптом в логах                                                 | Причина и решение                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Invalid configuration: TELEGRAM_BOT_TOKEN …`                   | Переменная не задана или скопирована с ошибкой                                         |
| `bot failed to start` … `(401)`                                 | Токен неверный или отозван — возьмите актуальный в @BotFather                          |
| `telegram polling conflict: another bot instance…`              | Бот с этим токеном запущен где-то ещё — остановите лишний экземпляр                    |
| Бот молчит, в логах `sender is not the owner` с вашим `user_id` | В `TELEGRAM_OWNER_USER_ID` указан не ваш Id — замените на `user_id` из лога            |
| Бот молчит, логов нет                                           | Сервис не запущен — проверьте статус деплоя у провайдера                               |
| Railway: ``The executable `pnpm` could not be found``           | Заполнено **Custom Start Command** — очистите поле и перезапустите деплой              |
| Railway: деплой **Skipped**, «No changes to watched files»      | Заполнено **Watch Paths** — очистите поле                                              |
| Railway: деплой **Skipped**, «CI check suite failed»            | На коммите есть упавшая проверка GitHub Actions — исправьте её или влейте новый коммит |

## Безопасность

- Токен хранится только в секретных переменных хостинга (или в `~/roi-bot.env` с правами `600`). В образ и repository он не попадает.
- При подозрении на утечку: @BotFather → `/revoke` → обновите `TELEGRAM_BOT_TOKEN` у хостинга.
- Бот не выполняет команд, меняющих состояние системы. Такие команды появятся позже и будут требовать вашего подтверждения.
