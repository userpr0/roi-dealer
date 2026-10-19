# @roi-dealer/payments

**Статус:** реализован (PHASE 20b — приём оплат, [спецификация](../../docs/phases/20b_payments.md), [ADR-0009](../../docs/ADR/0009-payments-merchant-of-record.md)).

Приём оплат через merchant of record Lemon Squeezy. Система ничего не списывает: владелец создаёт ссылку на оплату в кабинете провайдера и передаёт её боту (`/checkout`), провайдер присылает подписанный webhook, пакет записывает выручку, шаг воронки `payment`, возвраты и тестовые платежи.

## Что делает

| Функция                       | Что делает                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyLemonSqueezySignature` | `X-Signature` — HMAC-SHA256 сырого тела с секретом, сравнение в постоянное время                                                      |
| `parseLemonSqueezyEvent`      | Оплата (`order_created`, `paid`) или возврат (`order_refunded`) без налога; номер теста и UTM из `custom_data`; данных покупателя нет |
| `checkoutLink`                | Ссылка владельца + `checkout[custom][experiment_id]` и `checkout[custom][utm_source]`                                                 |
| `recordPaymentEvent`          | Стоп-кран → доступ → одна транзакция: тестовый заказ (ссылка проверена), выручка и шаг `payment`, прирост возврата (`recordRefund`)   |
| `handleLemonSqueezyWebhook`   | Подпись → разбор → запись; ответ `200` / `401` / `400` / `503` (провайдер повторит)                                                   |

## Правила использования

- Пишет только интеграция `PAYMENTS` (`integration:lemonsqueezy`) с доступом от владельца; база пускает выручку от интеграции только от неё.
- Каждое событие — один раз (`payment_events_once`); повтор доставки ничего не повторяет.
- Имя, почта и адрес покупателя не читаются, не хранятся и не логируются; секрет — только в Variables сервиса `api`.

## Export surface

| Экспорт                                                                                             | Назначение                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------- |
| `verifyLemonSqueezySignature`, `parseLemonSqueezyEvent`, `PaymentEvent`                             | Webhook провайдера              |
| `checkoutLink`, `LEMONSQUEEZY`, `MAX_WEBHOOK_BYTES`                                                 | Ссылка на оплату, пределы       |
| `recordPaymentEvent`, `handleLemonSqueezyWebhook`, `PaymentOutcome`, `WebhookResult`, `PaymentDeps` | Запись событий                  |
| `PAYMENTS`, `PAYMENTS_ACCESS`                                                                       | Личность интеграции и её запрос |
| `PACKAGE_NAME`                                                                                      | Идентификатор пакета            |
