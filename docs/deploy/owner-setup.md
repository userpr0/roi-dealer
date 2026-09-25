# Этап A — пошаговая настройка для владельца

> Выполняется один раз, около 45 минут. Порядок важен: сначала безопасность, потом запуск бота.
> Интерфейсы GitHub, Telegram и Railway иногда меняются: если кнопка называется чуть иначе, ищите ближайшую по смыслу. Если что-то не сходится — пришлите скриншот **без токенов и кодов**.

## Шаг 1. Тестовый бот и ваш Telegram Id (5 минут)

**1.1. Ваш Id**

1. В Telegram найдите **@userinfobot** → **Start**.
2. Бот ответит строкой `Id: 123456789` — это ваш `TELEGRAM_OWNER_USER_ID`. Сохраните число.

**1.2. Второй бот для тестов**

1. Откройте **@BotFather** (с синей галочкой) → отправьте `/newbot`.
2. Имя: например, `ROI Dealer Test`.
3. Username: должен заканчиваться на `bot` и быть свободным, например `roi_dealer_test_bot`.
4. BotFather пришлёт токен вида `123456789:AA…`. Сохраните его в менеджере паролей с пометкой **TEST**.

> Основной бот — для облака (Railway). Тестовый — только для запуска на вашем ПК (`pnpm dev:bot`). Токены никому не отправляйте, в том числе Claude.

**1.3. Токен основного бота** (понадобится в шаге 4)

@BotFather → `/mybots` → ваш основной бот → **API Token** → скопируйте в менеджер паролей с пометкой **PROD**.

## Шаг 2. Двухфакторная защита аккаунтов (10 минут)

Понадобится приложение-аутентификатор на телефоне: Google Authenticator, Microsoft Authenticator или менеджер паролей с поддержкой кодов.

**2.1. Почта** (через неё восстанавливаются все остальные аккаунты)

- Gmail: [myaccount.google.com](https://myaccount.google.com) → **Безопасность** → **Двухэтапная аутентификация** → включить.

**2.2. GitHub**

1. [github.com](https://github.com) → ваш аватар справа вверху → **Settings**.
2. Слева **Password and authentication** → **Enable two-factor authentication**.
3. Отсканируйте QR-код аутентификатором → введите 6-значный код.
4. **Скачайте recovery codes** и сохраните в менеджере паролей. Без них при потере телефона доступ к GitHub не восстановить.

**2.3. Telegram**

- Телефон: **Настройки** → **Конфиденциальность** → **Облачный пароль** (Two-Step Verification) → задать пароль и почту для восстановления.

**2.4. Railway**

- Если входите в Railway через GitHub (шаг 4), аккаунт защищён двухфакторкой GitHub.
- Если в Railway есть собственная двухфакторка (**Account Settings** → **Security**), включите и её.

## Шаг 3. GitHub: ветка `main`, защита и проверки безопасности (10 минут)

Откройте [github.com/userpr0/roi-dealer](https://github.com/userpr0/roi-dealer).

**3.1. Создать ветку `main`**

1. Слева вверху кнопка с названием ветки (сейчас `claude/roi-dealer-project-t2gwx9`) → нажмите.
2. В поле **Find or create a branch** введите `main`.
3. Нажмите **Create branch: main from 'claude/roi-dealer-project-t2gwx9'**.

**3.2. Сделать `main` основной**

1. Вкладка **Settings** репозитория → раздел **General**.
2. Блок **Default branch** → значок ⇄ (Switch to another branch) → выберите `main` → **Update**.
3. Подтвердите: **I understand, update the default branch**.

**3.3. Разрешить публикацию Mini App из `main`**

1. **Settings** → слева **Environments** → **github-pages**.
2. Блок **Deployment branches and tags**: если там выбраны конкретные ветки — **Add deployment branch or tag rule** → введите `main` → **Add rule**.

Если в блоке стоит «No restriction» или уже разрешена основная ветка, ничего делать не нужно.

**3.4. Защитить `main`**

Быстрый путь (1 минута): скачайте [`github-ruleset-protect-main.json`](github-ruleset-protect-main.json) → **Settings** → **Rules** → **Rulesets** → **New ruleset** ▾ → **Import a ruleset** → выберите файл → **Create**. В файле те же настройки, что ниже, но для ветки задан шаблон `main`, а не пункт «Include default branch».

Вручную:

1. **Settings** → слева **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. **Ruleset Name:** `Protect main`. **Enforcement status:** `Active`.
3. **Target branches** → **Add target** → **Include default branch**.
4. В блоке **Rules** отметьте:
   - ✅ **Restrict deletions**
   - ✅ **Block force pushes**
   - ✅ **Require a pull request before merging**, **Required approvals: 0** (изменения вливаете вы сами кнопкой Merge; с 1 обязательным одобрением свои PR влить нельзя).
   - ✅ **Require status checks to pass** → **Add checks** → найдите и добавьте **Typecheck, lint, test, build** и **Build bot Docker image**.
5. **Bypass list** оставьте пустым.
6. Внизу **Create**.

После этого в `main` нельзя залить код напрямую: только через pull request с зелёными проверками.

**3.5. Включить проверки безопасности**

**Settings** → слева **Code security** (может называться **Advanced Security** или **Code security and analysis**). Включите (**Enable**):

- **Dependency graph** (обычно уже включён)
- **Dependabot alerts** — предупреждения об уязвимых зависимостях
- **Dependabot security updates** — автоматические PR с исправлениями
- **Secret scanning** (или **Secret Protection**) и **Push protection** — GitHub не даст запушить токен или ключ
- По желанию **CodeQL analysis** → **Default** — бесплатный анализ кода для публичного репозитория

## Шаг 4. Railway: аккаунт, лимит расходов, запуск бота (15–20 минут)

**4.1. Аккаунт**

1. Откройте [railway.com](https://railway.com) → **Login** → **Login with GitHub** → подтвердите доступ.
2. Если Railway предложит тариф, для круглосуточной работы выберите **Hobby** (около $5/мес, проверьте актуальную цену) и добавьте карту.

**4.2. Лимит расходов (D-014 п.2, лимит $20 из D-007)**

1. Настройки аккаунта или workspace → раздел **Usage** (или **Billing**) → **Usage limits**.
2. **Custom email alert:** `$15` — письмо при приближении к лимиту.
3. **Hard limit:** `$20` — выше этой суммы Railway остановит сервисы, и лишние деньги не спишутся.
4. Сохраните.

**4.3. Проект из GitHub**

1. **New Project** (или **+ New**) → **Deploy from GitHub repo**.
2. Если попросит доступ: **Configure GitHub App** → **Only select repositories** → `userpr0/roi-dealer` → **Save**.
3. Выберите `roi-dealer`. Railway создаст сервис и может сразу начать сборку. Если первая сборка упадёт — это нормально: переменные ещё не заданы.

**4.4. Переменные**

1. Нажмите на сервис → вкладка **Variables** → **+ New Variable** (или **Raw Editor**, чтобы вставить всё сразу).
2. Добавьте:

   | Переменная                | Значение                                    |
   | ------------------------- | ------------------------------------------- |
   | `RAILWAY_DOCKERFILE_PATH` | `apps/bot/Dockerfile`                       |
   | `TELEGRAM_BOT_TOKEN`      | токен **основного** (PROD) бота из шага 1.3 |
   | `TELEGRAM_OWNER_USER_ID`  | ваш Id из шага 1.1                          |

3. Сверху появится кнопка **Deploy** / **Apply changes** → нажмите.

**4.5. Проверить настройки сервиса** (вкладка **Settings** сервиса)

- **Source → Branch:** `main`.
- **Networking:** публичный домен **не нужен**, не нажимайте **Generate Domain**.

**4.6. Проверка**

1. Вкладка **Deployments** → последняя сборка → **View logs**. Сборка занимает 2–4 минуты.
2. В Telegram придёт **«🟢 ROI Dealer bot запущен»**.
3. Отправьте основному боту `/status` → ответ «🟢 ROI Dealer: ok».

Если сообщения нет — откройте логи и пришлите текст ошибки (без токена). Частые причины и решения — в [`telegram-bot.md`](telegram-bot.md#5-если-что-то-не-так).

> После запуска в облаке не запускайте **основной** бот на ПК: два экземпляра с одним токеном мешают друг другу. Для ПК используйте тестовый бот из шага 1.2.

## Шаг 5. Сообщить Claude

Напишите в чат:

1. **«main готов»** — Claude перейдёт на работу через pull request: изменения появятся в PR, а вливаете их вы кнопкой **Merge** после зелёных проверок.
2. **«пиши A6»** — Claude напишет инструкции на аварии.
3. **«одобряю Phase 02»** — Claude начнёт PHASE 02 (PostgreSQL Foundation).

## Итоговый чек-лист

- [ ] Сохранены ваш Id, токен TEST-бота, токен PROD-бота
- [ ] Двухфакторка: почта, GitHub (recovery codes сохранены), Telegram
- [ ] `main` создана и стала основной
- [ ] Для `github-pages` разрешена ветка `main`
- [ ] Ruleset `Protect main` активен (PR, проверки CI, запрет force push и удаления)
- [ ] Dependabot, secret scanning и push protection включены
- [ ] Railway: лимит $20 и оповещение на $15
- [ ] Бот в Railway прислал «🟢 запущен» и отвечает на `/status`
