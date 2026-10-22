# ROI Dealer: Hetzner — основной, Railway — резерв

> **Решение:** D-029, [ADR-0010](../ADR/0010-hosting-hetzner.md).
>
> **Что делает сервер сам:**
>
> - ставит Docker, создаёт базу и получает HTTPS-сертификат;
> - при первом запуске забирает все данные из базы Railway — доступы, Evidence, решения;
> - раз в 5 минут ставит новую версию после зелёного CI;
> - каждую ночь делает копию базы у себя и копирует её в базу Railway.
>
> Railway остаётся тёплым резервом: его сервисы выключены, а база отстаёт от основной не больше чем на сутки.
>
> **Стоимость:** Hetzner около €5–6 в месяц вместе с копиями диска, плюс Railway Hobby около $5 — в пределах лимита D-007 ($20). Счета вносите в бот, например `/cost 6 инфраструктура Hetzner`.

## 1. Подготовьте значения (5 минут)

Соберите строки в заметку на телефоне. Никому их не отправляйте, в том числе в чат с Claude.

| Строка                   | Где взять                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESERVE_DATABASE_URL`   | Railway → проект **bountiful-warmth** → **Postgres** → **Variables** → **DATABASE_PUBLIC_URL** → глазок → скопировать значение. Начинается с `postgresql://`                                                        |
| `TELEGRAM_BOT_TOKEN`     | Сначала в боте `/stop Переезд на Hetzner` → **Да**. Потом **@BotFather** → `/mybots` → ваш бот → **API Token** → **Revoke current token** → скопируйте новый токен. Бот в Railway перестанет работать — так и нужно |
| `TELEGRAM_OWNER_USER_ID` | **@userinfobot** → `/start` → число после **Id**                                                                                                                                                                    |
| `PUBLIC_CONTACT_EMAIL`   | Ваша почта для запросов об удалении данных (видна на странице `/privacy`)                                                                                                                                           |
| `GEMINIFREE_API_KEY`     | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → ключ проекта **без** оплаты                                                                                                                      |
| `GEMINI_API_KEY`         | Там же → ключ проекта **с** оплатой                                                                                                                                                                                 |

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` и `LEMONSQUEEZY_WEBHOOK_SECRET` оставьте пустыми, если этих ключей нет.

`/stop` нужен затем, чтобы worker в Railway больше ничего не тратил. Стоп-кран переедет вместе с базой, поэтому на Hetzner система тоже стартует на паузе — её включит `/resume` (шаг 3).

## 2. Создайте сервер (5 минут)

1. [console.hetzner.com](https://console.hetzner.com) → проект **Default** (или **New project** → `roi-dealer`) → **Create server**.
2. Заполните:

   | Поле             | Что выбрать                                                                                    |
   | ---------------- | ---------------------------------------------------------------------------------------------- |
   | Location         | Nuremberg, Falkenstein или Helsinki                                                            |
   | Image            | **Ubuntu 24.04**                                                                               |
   | Type             | **Shared vCPU → x86 (Intel/AMD)**, самый дешёвый с **4 GB** памяти (CX22 или CX23). **Не Arm** |
   | Networking       | Public IPv4 — включено, IPv6 — включено                                                        |
   | SSH keys         | пропустить                                                                                     |
   | Volumes          | пропустить                                                                                     |
   | Firewalls        | пропустить — файрвол настроит сервер                                                           |
   | **Backups**      | **включить** (+20% к цене, копия диска каждый день)                                            |
   | **Cloud config** | вставить текст ниже со своими значениями                                                       |
   | Name             | `roi-dealer`                                                                                   |

3. Текст для **Cloud config**. Впишите значения сразу после `=`, без кавычек и пробелов, больше ничего не меняйте:

   ```yaml
   #cloud-config
   write_files:
     - path: /opt/roi-dealer/secrets.env
       permissions: '0600'
       owner: root:root
       content: |
         TELEGRAM_BOT_TOKEN=
         TELEGRAM_OWNER_USER_ID=
         PUBLIC_CONTACT_EMAIL=
         GEMINIFREE_API_KEY=
         GEMINI_API_KEY=
         OPENAI_API_KEY=
         ANTHROPIC_API_KEY=
         LEMONSQUEEZY_WEBHOOK_SECRET=
         RESERVE_DATABASE_URL=
   runcmd:
     - - bash
       - -c
       - curl -fsSL https://raw.githubusercontent.com/userpr0/roi-dealer/main/infra/hetzner/install.sh -o /root/roi-dealer-install.sh && bash /root/roi-dealer-install.sh > /var/log/roi-dealer-install.log 2>&1
   ```

   Пробелы в начале строк важны: вставляйте блок целиком. Тот же текст лежит в репозитории: `infra/hetzner/cloud-init.yaml`.

4. **Create & Buy now**. Пароль root придёт на почту — он нужен только для консоли Hetzner, сохраните его.

## 3. Проверьте (через 10–15 минут)

1. Бот пришлёт **«🟢 ROI Dealer bot запущен»** с версией.
2. `/resume` → **Да** — снять стоп-кран, который переехал из Railway.
3. `/decisions`: доступы переехали, новым будет только **«Доступ: Lemmy (lemmy.world)»** → ✅ → **Да**.
4. `/status`:
   - `🟢 database: ok`;
   - AI — провайдеры с ✓;
   - «🧭 Запуск: всё настроено ✅».
5. Кнопка **«Пульт»** открывает панель с новым адресом.

Если через 20 минут бот молчит: Hetzner → сервер → **Power** → **Reboot**. Если и это не помогло — напишите Claude, что видите.

## 4. Переведите Railway в резерв (3 минуты)

Для каждого сервиса — **bot**, **worker**, **api** — но **не Postgres**:

1. Откройте сервис → **Settings** → **Source** → у автоматических деплоев нажмите **Disable**. Иначе каждое обновление снова запустит сервис в Railway.
2. **Deployments** → у верхнего (активного) деплоя **⋮** → **Remove**. Сервис остановится.

Postgres в Railway оставьте включённым: сервер Hetzner каждую ночь копирует в него базу.

## Если Hetzner упал — переключиться на Railway (10 минут)

1. **@BotFather** → `/mybots` → бот → **API Token** → **Revoke current token** → скопируйте новый токен.
2. Railway → **bot** → **Variables** → `TELEGRAM_BOT_TOKEN` → вставьте новый токен. `api` берёт его ссылкой сам.
3. В **bot**, **worker** и **api**: **Settings** → **Source** → **Enable**, затем **Deployments** → **Deploy** (на компьютере: Ctrl/Cmd + K → «Deploy Latest Commit»).
4. Через 5 минут бот пришлёт «запущен». Данные — на момент последней ночной копии.

Вернуться на Hetzner — напишите Claude: нужна свежая копия из Railway, это отдельный шаг.

## Повседневное

| Что                           | Как                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Новая версия                  | Ничего: сервер ставит её сам через 5–10 минут после зелёного CI. Бот напишет «запущен» с новой версией      |
| Перезапуск                    | Hetzner → сервер → **Power** → **Reboot**. Данные сохраняются                                               |
| Копии базы                    | Сами: снимок диска Hetzner каждый день, копия базы каждую ночь на сервере (7 дней) и в Postgres Railway     |
| Адрес `api` (Пульт, страницы) | `https://<IP сервера через дефисы>.sslip.io`, например `https://203-0-113-7.sslip.io`. Бот получает его сам |

### Заменить ключ

1. Hetzner → сервер → кнопка **>\_** (**Console**).
2. Логин `root`, пароль — из письма Hetzner.
3. Введите `bash /opt/roi-dealer/app/infra/hetzner/set-key.sh` и нажмите Enter.
4. Введите имя переменной (например `GEMINI_API_KEY` или `RESERVE_DATABASE_URL`), затем значение. Значение при вводе не отображается.

Скрипт перезапустит только те сервисы, которые используют этот ключ.
