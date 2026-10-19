# PHASE 19a REPORT — Media Factory (минимум)

```text
Phase: 19a — Media Factory (минимум): лендинг и рекламные тексты теста
Status: PASS
Date: 2026-10-19
Spec: docs/phases/19a_media_factory.md (составлена Claude по D-022; D-012, план 19_media_factory.plan.md)
Approval mode: D-022 — Уровень 3 одобрен; порядок 19a → 21 → 20 → 20b
```

## Implemented

- **AI-задача `write-landing`** (новый пакет `@roi-dealer/media`):
  - по гипотезе и возможности пишет страницу: заголовок, подзаголовок, проблема, три выгоды, три шага, оффер, период цены, кнопка, 2–4 вопроса;
  - и три рекламных текста для канала гипотезы;
  - тир `bulk`, доля дня 3 % (у судей теперь 22 %), эталон из 20 гипотез с оценкой.
- **Проверка кодом (`toLandingContent`):**
  - длины и число частей;
  - без выдуманных доказательств: отзывы, «trusted by», число клиентов, рейтинги, награды, гарантии, «осталось N», «лучший / №1»;
  - без сумм денег и цифр результата, которых нет во входе;
  - без ссылок, почты и телефонов; только английский.

  Не прошло — одна повторная попытка со списком замечаний.

- **Цену и честную пометку ставит код:** цена — из гипотезы (`$12.00 / month`, 0 → «Free while in early access»); пометка — `preorder` («предзаказ, полный возврат») или `in_development` («в разработке, оставьте почту»).
- **Сущность `MediaAsset`** (17-я): вид `landing`, тест, гипотеза, возможность, проверенное содержимое, `slug`, `previewToken` (128 бит). Цикл `draft` → `approved` | `rejected`, дальше `released` / `retired` (PHASE 21). Одобряет и отклоняет только владелец.
- **Агент `landing-writer` («Автор лендингов»):**
  - доступ — в `/decisions`, стоп-кран — первым шагом;
  - берёт тесты с артефактом `landing` (`planned`, `awaiting_approval`, `approved`) без живого лендинга;
  - после ❌ переписывает, видя отклонённый заголовок; не больше двух переписываний на тест;
  - лендинг и запись `agent_work` — одной транзакцией;
  - расписание в worker — `LANDING_INTERVAL_MS` (15 минут).
- **Пульт:**
  - карточка «🎨 Лендинг для теста №N» приходит сама, один раз на версию: текст, цена с пометкой, реклама, ссылка на предпросмотр;
  - ✅ Одобрить / ❌ Переписать → подтверждение → одна команда владельца; устаревшая карточка ничего не меняет;
  - строка «🎨 Лендинг: …» в карточке теста `/experiments`;
  - `/economics` — «🎨 Лендинги: AI $X · одобрено N · $Y за одобренный» (Cost per Approved Asset, D-012).
- **Предпросмотр `GET /p/<token>`** в `apps/api` (новый пакет `@roi-dealer/site`):
  - статичная страница по шаблону `renderLanding`: без JavaScript и внешних ресурсов, всё экранировано, `noindex`;
  - заголовки: строгий CSP, `X-Frame-Options: DENY`, `no-store`;
  - неизвестный, отклонённый или снятый лендинг — 404; не `GET` / `HEAD` — 405.

## Files created

- `packages/media/` — `landing.ts` (проверка, пометка, цена), `write-landing.ts` (задача и эталон), `render.ts` (шаблон, slug, токен).
- `packages/site/` — `pages.ts` (страницы сайта для `api`).
- `packages/domain/src/entities/media-asset.ts`.
- `packages/agents/src/landing/writer.ts`.
- `packages/command-center/src/media.ts`.
- `database/migrations/0015_media.sql`.
- `tests/unit/media/media.test.ts`, `tests/integration/media/media.test.ts`, `tests/support/media-answers.ts`.
- `docs/phases/19a_media_factory.md`, этот отчёт.

## Files modified

- **Домен:** тип сущности `media_asset`, `mediaAssetIdSchema`.
- **Права:** `media_asset` — `research.write` (создаёт агент, решает владелец).
- **База:** репозиторий `mediaAssets` (`listByExperiments`, `getBySlug`, `getByPreviewToken`); `agentWork.pendingLandings`; `agent_work` принимает `experiment` и `media_asset`.
- **Судьи:** доля дня 0,25 → 0,22.
- **Пульт:** карточки лендингов в рассылке карточек, кнопки `ma`, строка в `/experiments`, строка в `/economics`, подписи и журнал.
- **Приложения:**
  - `api` — маршрут `/p/<token>`, HTML-ответы с заголовками страницы;
  - бот — `PUBLIC_API_URL`;
  - worker — агент лендингов и его задача в evals.
- **Тесты:** число типов событий, сумма долей дня, список миграций.
- **Документы:** `OWNER_DECISIONS.md` (D-022), `CURRENT_STATE.md`, `ROADMAP.md`, `SYSTEM_ARCHITECTURE.md`, `phases/README.md`, `CLAUDE.md`, `deploy/worker.md`, `deploy/telegram-bot.md`, `deploy/api.md`, README пакетов, схема и README миграций, `.env.example`.

## Database migrations

- **`0015_media`:**
  - тип сущности `media_asset`;
  - таблица `media_assets`: содержимое — JSON-текст до 20 000 символов (CHECK: JSON-объект), уникальные `slug` и `preview_token`;
  - уникальный частичный индекс `media_assets_one_live`: один `draft` / `approved` / `released` лендинг на тест;
  - триггеры версий, запрет удаления, «нет записи без события»;
  - `agent_work.subject_type` — плюс `experiment` и `media_asset`.

## Tests added

- **Unit (10):**
  - проверка текста: хорошая страница, слова аудитории с числами не считаются выдумкой;
  - восемь видов выдуманных доказательств; суммы и цифры результата только из входа;
  - ссылки, почта, другой язык, длины, число частей;
  - пометка и цена кодом;
  - шаблон: без скриптов и внешних адресов, экранирование, `noindex`, баннер и неактивная кнопка в предпросмотре;
  - `slug` и токен;
  - эталон: 20 случаев, выдумки и молчание не проходят;
  - `MediaAsset`: одобряет и отклоняет только владелец.
- **Integration (6, PostgreSQL, фейковый Claude, настоящий HTTP):**
  - доступ, затем evals;
  - черновик пишется один раз: цена, пометка, `slug`;
  - карточка один раз, ссылка предпросмотра, кнопки, строка в `/experiments`;
  - предпросмотр: 200, CSP, `DENY`, без скриптов; 404 и 405;
  - ❌ → переписывание с отклонённым заголовком и одной правкой выдумки → ✅ от владельца; устаревшая кнопка; строки `/experiments` и `/economics`;
  - после двух переписываний агент не пишет; база не пускает второй живой лендинг; тексты страниц не в логах.

## Test results

| Проверка            | Результат                                                          |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm typecheck`    | pass                                                               |
| `pnpm lint`         | pass (0 warnings)                                                  |
| `pnpm format:check` | pass                                                               |
| `pnpm test`         | 77 файлов, 810 тестов — pass (unit 545, integration 265); было 794 |
| `pnpm build`        | pass                                                               |
| Docker-образы       | бот, worker и api собираются                                       |

## Security implications

- **Страница не исполняет код:** шаблон без JavaScript, `default-src 'none'`, всё экранировано; модель не может вставить ссылку, почту или телефон — код отклоняет такой текст.
- **Предпросмотр закрыт:** адрес — случайный токен 128 бит, `noindex`, `no-store`; отклонённые и снятые страницы — 404.
- **Честность (§2.17):** выдуманные отзывы, цифры, гарантии и дефицит отклоняет код; цену и пометку «в разработке» / «предзаказ с возвратом» модель изменить не может.
- **Решает владелец:** одобрение и отклонение — только `owner`, с подтверждением и версией в кнопке.
- **Логи:** без текстов страниц и подсказок.

## Cost implications

- **AI:** доля дня 3 % от квоты (при $50 в месяц — до ~5 центов в день на лендинги); одна страница — одна-две дешёвых модели `bulk`. Видно в `/economics` как стоимость одобренного лендинга.
- **Инфраструктура:** $0 сверх плана — предпросмотр отдаёт уже запланированный сервис `api`.

## Known limitations

- **Правки текста владельцем вручную нет:** только ❌ и переписывание агентом (§2.15).
- **Без картинок:** страница — текст и CSS; картинки и видео — 19b.
- **Один язык** — английский (рынки D-008).
- **Предпросмотр нужен с `api`:** без сервиса `api` и `PUBLIC_API_URL` у бота карточка показывает только текст.

## Technical debt

- Нет.

## Architecture deviations

- Нет. Новые пакеты `media` (задача, проверка, шаблон) и `site` (страницы для `api`) — по правилу «логика в `packages/*`, `apps/*` тонкие». Стек не меняется: HTML собирается строками без новых зависимостей.

## Scope decisions

- **Содержимое — JSON-текст, а не `jsonb`:** драйвер не преобразует его неявно; база проверяет, что это объект, код при чтении проверяет схему домена.
- **Переписывание — по версии отклонённого лендинга:** каждая работа агента записывается один раз, а у теста их может быть до трёх.
- **Три рекламных текста — в той же задаче:** один вызов вместо двух, одна проверка владельцем.

## Business hypothesis enabled by this phase

У теста, которому нужна страница, она появляется сама за минуты, честная по умолчанию: владелец только проверяет и нажимает ✅. Стоимость одобренного лендинга видна и сравнима между тестами.

## Authoritative data paths verified

```text
worker → landingWriterAgent: assertAgentsRunning → active principal → pendingLandings
  → runTask(write-landing) → checkLanding (≤ 2 попытки) → createMediaAsset (draft)
  → transaction: media_assets insert + agent_work (experiment vN | media_asset vN)
bot notifier → media.card (landing-card-<id>-v<n>) → карточка с /p/<token>
✅ / ❌ → [подтверждение] → media.review: approveMediaAsset | rejectMediaAsset (owner)
api GET /p/<token> → previewPage → mediaAssets.getByPreviewToken → renderLanding (preview)
/economics → ai_calls (write-landing, task) / одобренные лендинги месяца
```

## Ready for next phase

- **Следующая — PHASE 21 Solution Factory** (D-022): Release Gate §7.2, публикация одобренной страницы на `api` и события воронки.
- **Действия владельца после вливания:** `/decisions` → «Доступ: Автор лендингов» → ✅; в Variables бота — `PUBLIC_API_URL` (адрес сервиса `api`).
