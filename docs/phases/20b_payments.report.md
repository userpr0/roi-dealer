# PHASE 20b REPORT — Приём оплат

```text
Phase: 20b — Приём оплат: merchant of record, ссылка на оплату, webhook → выручка и возвраты
Status: PASS
Date: 2026-10-19
Spec: docs/phases/20b_payments.md (составлена Claude по D-022); ADR-0009 (Accepted под D-022)
Approval mode: D-022 — последняя фаза минимального Уровня 3
```

## Implemented

- **ADR-0009:** merchant of record — Lemon Squeezy, через ссылки на оплату (страницы остаются без скриптов) и подписанный webhook. Paddle — отдельным адаптером позже: его оформление требует скрипта на странице или API продавца.
- **Ссылка на оплату — сущность `Checkout`** (19-я):
  - `/checkout <№> <ссылка>` — только владелец, только платный предзаказ, «было → станет», подтверждение, одна команда;
  - ссылка — только https на `*.lemonsqueezy.com`, путь `/buy/…`;
  - тестовый заказ в Test mode отмечает её **проверенной**; замена на боевую проверку сохраняет.
- **Кнопка предзаказа** на странице — клик в воронку и `303` на ссылку с номером теста и UTM-источником в `checkout[custom]`.
- **Webhook `POST /webhooks/lemonsqueezy`** (`@roi-dealer/payments`):
  - подпись `X-Signature` (HMAC-SHA256 тела, постоянное время), тело до 64 КБ, без секрета маршрута нет;
  - читаются только событие, номер и суммы заказа, статус, режим теста, `custom_data` — имя и почта покупателя нет;
  - пишет «Платежи Lemon Squeezy» (`integration:lemonsqueezy`) с доступом от владельца; стоп-кран и нет доступа → `503`, провайдер повторит;
  - тестовый заказ → оплата проверена; оплата → `RevenueEntry` без налога (`preorder` для предзаказа) и шаг воронки `payment`; возврат → расход `refund` на прирост суммы; заказ без номера теста — выручка без привязки;
  - каждое событие один раз (журнал `payment_events`), всё одной транзакцией.
- **Release Gate:** «Оплата проверена тестовым платежом» — по проверенной ссылке; без неё платный предзаказ не выпускается.
- **Пульт:** строка «💳 Оплата» в карточке теста; уведомления о тестовом платеже, оплате и возврате — по одному разу.
- **Проверка трат:** возвраты от провайдера не считаются автоматическими тратами.

## Files created

- `docs/ADR/0009-payments-merchant-of-record.md`.
- `packages/payments/` — `lemonsqueezy.ts` (подпись, разбор, ссылка), `record.ts` (запись событий, webhook).
- `packages/domain/src/entities/checkout.ts`, `packages/database/src/payments.ts`, `packages/command-center/src/payments.ts`.
- `database/migrations/0018_payments.sql`.
- `tests/unit/payments/payments.test.ts`, `tests/integration/payments/payments.test.ts`, `tests/support/fake-lemonsqueezy.ts`.
- `docs/phases/20b_payments.md`, этот отчёт, `docs/deploy/START.md`.

## Files modified

- **Домен:** тип `checkout`, `checkoutIdSchema`.
- **Права:** `payment.record`; интеграциям — `revenue.record` и `payment.record`; права записи `checkout`.
- **База:** `checkoutsTable`, репозиторий `checkouts`, `database.payments`; автоматические траты без возвратов.
- **Site:** кнопка предзаказа ведёт на оплату.
- **Пульт:** `/checkout`, кнопки `pl`, строка оплаты, Release Gate, уведомления, подписи, история.
- **`api`:** маршрут webhook, `LEMONSQUEEZY_WEBHOOK_SECRET`, запрос доступа «Платежи Lemon Squeezy», `X-Signature`, тело до 64 КБ для webhook.
- **Тесты:** права интеграции и выручки (правило изменено ADR-0009), меню бота, число типов событий, список миграций.
- **Документы:** `CURRENT_STATE.md`, `ROADMAP.md`, `SYSTEM_ARCHITECTURE.md`, `phases/README.md`, `CLAUDE.md`, ADR README, `deploy/api.md`, `deploy/telegram-bot.md`, README `payments` и `site`, схема и README миграций, `.env.example`.

## Database migrations

- **`0018_payments`:**
  - тип сущности `checkout`; таблица `checkouts` (версии с событием; ссылка Lemon Squeezy по CHECK; создаёт только `owner`; одна активная на тест);
  - журнал `payment_events` (только добавление): `payment_events_once` — провайдер + ключ события;
  - `revenue_entries_integration_provider` — выручка от интеграции только от `lemonsqueezy`.

## Tests added

- **Unit (7):** подпись (верная, другой секрет, изменённое тело, мусор, без заголовка); разбор оплаты без налога и без данных покупателя; возвраты пропорционально; игнор и ошибки; ссылки Lemon Squeezy и подделки; ссылка с номером теста; `Checkout` — владелец, проверка один раз, замена ссылки.
- **Integration (9, PostgreSQL, настоящий HTTP):** `/checkout` с отказами и подтверждением; кнопка страницы ведёт на оплату с номером теста; неверная подпись — 401 без записи; без доступа — 503, затем тестовый заказ проверяет ссылку и Release Gate, повтор не дублирует; оплата → выручка `preorder` $49 без налога и шаг `payment`; частичный и полный возврат — $24.50 + $24.50, повтор не дублирует, не автоматическая трата; заказ без теста и стоп-кран; уведомления по одному разу; CHECK выручки от другой интеграции; ни почты, ни имени покупателя, ни секрета в логах.

## Test results

| Проверка            | Результат                                                         |
| ------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`    | pass                                                              |
| `pnpm lint`         | pass (0 warnings)                                                 |
| `pnpm format:check` | pass                                                              |
| `pnpm test`         | 83 файла, 859 тестов — pass (unit 568, integration 291); было 843 |
| `pnpm build`        | pass                                                              |
| Docker-образы       | бот, worker и api собираются                                      |

## Security implications

- **Ключа со списаниями в системе нет:** только секрет подписи webhook; оплату и возвраты делает провайдер.
- **Подделка webhook** без секрета невозможна (HMAC, постоянное время); повтор доставки ничего не повторяет.
- **Данные покупателя** не читаются из тела и не хранятся; в логах — только вид события и итог.
- **Выручка от интеграций** — только от `integration:lemonsqueezy` (база), только с активным доступом от владельца; стоп-кран останавливает запись.

## Cost implications

- **$0 сверх плана:** абонентской платы нет; комиссия Lemon Squeezy — с каждой продажи, видна в кабинете провайдера. Лимиты D-007 не затрагиваются.

## Known limitations

- **Комиссия провайдера** не попадает в экономику автоматически: в выручке — сумма без налога.
- **Возврат, который больше записанного в тест** (или по незапущенному тесту), записывается в журнал и приходит уведомлением «внесите сами».
- **Формат webhook** сверен по документации и примерам Lemon Squeezy; первая настоящая проверка — тестовый платёж владельца в Test mode (без него Release Gate не пропустит).
- **Paddle** не подключён (ADR-0009, п. 6).

## Technical debt

- Нет.

## Architecture deviations

- Нет: решение записано ADR-0009 под D-022; новых npm-зависимостей нет.

## Scope decisions

- **Без API провайдера:** ссылки создаёт владелец в кабинете, система только принимает webhook — меньше секретов и прав.
- **Выручка без налога:** налог платит merchant of record, он не наш доход.
- **Подписки и лицензии** — с продуктом (PHASE 22).

## Business hypothesis enabled by this phase

Предзаказ проверяется настоящими деньгами: человек платит на странице провайдера, выручка, воронка и возвраты попадают в тест сами, а ROI и итог теста считаются по фактическим оплатам.

## Authoritative data paths verified

```text
/checkout N <ссылка> → pl:y → checkout.set: createCheckout | changeCheckoutUrl (owner)
/l/<slug>/go → cta_click → 303 <ссылка>?checkout[custom][experiment_id]=…&…[utm_source]=…
POST /webhooks/lemonsqueezy → verifyLemonSqueezySignature → parseLemonSqueezyEvent
  → стоп-кран → доступ integration:lemonsqueezy → transaction:
     test order → payment_events test_order + markCheckoutTested
     paid order → revenue_entries (preorder | payment) + payment_events + funnel payment
     refund → recordRefund (прирост) → cost_entries refund + payment_events
бот → payment.notice (payment-notice-<id>) → уведомление
```

## Ready for next phase

- **Минимальный Уровень 3 собран** (D-022: 19a → 21 → 20 → 20b). Дальше — запуск по [`deploy/START.md`](../deploy/START.md) и первые тесты; этап F (18, 22, 23) и 19b — по итогам.
- **Действия владельца:** вливание PR, переменные и одобрения — в [`deploy/START.md`](../deploy/START.md).
