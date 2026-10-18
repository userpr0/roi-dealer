# Worker в облаке (Railway): сбор данных

> **Когда:** после вливания PR с PHASE 05, когда облачная PostgreSQL и бот уже работают ([database.md](database.md)).
> **Что делает worker:** раз в 15 минут проверяет источники из каталога (сейчас — Hacker News). Сначала просит у вас доступ в `/decisions`; после одобрения забирает новые посты (не чаще раза в час, не больше 30 за раз), вычищает контакты и ники и сохраняет Evidence.
> Интерфейс Railway меняется: если кнопка называется иначе, ищите ближайшую по смыслу.

## Сколько стоит

Worker почти всё время ждёт: обычно $1–3 в месяц. Вместе с ботом и базой — в пределах лимита инфраструктуры $20/мес (D-007). Лимиты расходов в Railway уже стоят.

## 1. Создать сервис (около 5 минут)

1. [railway.com/dashboard](https://railway.com/dashboard) → проект с ботом → **+ Create** → **GitHub Repo** → `userpr0/roi-dealer`.
2. Railway может создать несколько **новых** сервисов, по одному на каждое приложение репозитория:
   - оставьте один из них (он станет worker);
   - остальные новые удалите: сервис → **Settings** → внизу **Delete Service**.

   Прежний сервис бота с зелёным **Online** не трогайте. Если среди новых появился второй бот, удалите именно его: два бота с одним токеном мешают друг другу.

3. Новый сервис → **Settings** → вверху имя → `worker`.
4. **Variables** → **Raw Editor** → две строки → **Update Variables**:

   ```
   RAILWAY_DOCKERFILE_PATH=apps/worker/Dockerfile
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   `DATABASE_URL` — ссылка на переменную базы: пароль не копируется руками и не попадает в чат.

5. **Settings** — как у бота:

   | Раздел     | Поле                           | Значение                                                          |
   | ---------- | ------------------------------ | ----------------------------------------------------------------- |
   | Source     | Root Directory                 | пусто                                                             |
   | Source     | Branch connected to production | `main`                                                            |
   | Source     | Wait for CI                    | включено                                                          |
   | Build      | Builder                        | Dockerfile (задаётся `RAILWAY_DOCKERFILE_PATH`)                   |
   | Build      | Custom Build Command           | пусто                                                             |
   | Build      | Watch Paths                    | пусто                                                             |
   | Deploy     | Pre-deploy Command             | `node /app/node_modules/@roi-dealer/database/dist/migrate-cli.js` |
   | Deploy     | Custom Start Command           | **пусто**                                                         |
   | Deploy     | Serverless                     | выключено — worker работает постоянно                             |
   | Scale      | Replicas                       | 1                                                                 |
   | Scale      | Replica Limits                 | 0.5 vCPU, 0.5 GB — защита бюджета                                 |
   | Networking | Public domain                  | не создавать                                                      |

   Миграции запускают и бот, и worker. Это безопасно: раннер берёт блокировку и пропускает уже применённые файлы.

6. Вверху **Apply N changes** → **Deploy**. Через 2–4 минуты карточка `worker` станет **Online**.

## 2. Одобрить источник

1. Telegram → `/decisions` → карточка **«Доступ: Hacker News»**.

   В карточке написано, что собирается и на каких условиях:
   - только посты Ask HN;
   - короткие цитаты без ников и контактов;
   - ничего не публикуется.

2. **✅ Одобрить** → **Да**.
3. Не позже чем через 15 минут worker заберёт первые посты.

Если отклонить карточку, источник отключится навсегда. Приостановить или отозвать доступ позже можно в `/access`.

## 3. Проверка

| Где                                  | Что должно быть                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Railway → `worker` → **Deploy Logs** | `evidence collection scheduled`; до одобрения — `evidence collection skipped` с `access_not_active` |
| Telegram → `/decisions`              | Карточка «Доступ: Hacker News»                                                                      |
| После одобрения, логи                | `evidence collected` с числом элементов и замен (`redactions`)                                      |
| Telegram → `/journal` → **День**     | `Интеграция source:hacker-news · ➕ Доказательство ×N`                                              |
| Telegram → `/access`                 | Hacker News — активен, с кнопками ⏸ / ⛔                                                            |
| Дайджест в 10:00                     | Строка «📚 Новых доказательств за сутки: N»                                                         |

## 4. Остановить сбор

- **Всё сразу:** `/stop` в Telegram — стоп-кран останавливает и сбор.
- **Один источник:** `/access` → ⏸ (вернуть — ▶️) или ⛔ (навсегда).
- **Сам worker:** Railway → `worker` → **Settings** → **Remove** / **Delete Service**. Бот и данные не пострадают.
