# @roi-dealer/telegram

**Статус:** реализован (фаза 13a, [ADR-0003](../../docs/ADR/0003-early-telegram-owner-bot.md)).

Интеграция с Telegram Bot API без сторонних bot-фреймворков: `fetch` + Zod.

## Export surface

| Export                                                                       | Назначение                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTelegramClient({ token, baseUrl?, requestTimeoutMs? })`               | Типизированный клиент: `getMe`, `getUpdates`, `sendMessage` (plain text), `setMyCommands`. Ответы валидируются Zod; `ok:false` → `TelegramApiError` (`errorCode`, `retryAfterSeconds`); сеть / таймаут / мусор → `TelegramRequestError`. Токен вырезается из всех сообщений об ошибках. |
| `createLongPoller({ client, logger, onUpdate, onFatalError })`               | Long polling: последовательная обработка, продвижение offset, экспоненциальный backoff (до 30 s), `retry_after` для 429, понятный лог для 409, фатальная остановка на 401 / 404, подтверждение offset при `stop()`.                                                                     |
| `createOwnerCommandRouter({ ownerUserId, commands, client, logger, … })`     | Обрабатывает только личные сообщения владельца; чужие и групповые — отбрасывает без ответа. Текст сообщений не логируется. Каждое обновление получает `correlation_id = tg-update-<id>`.                                                                                                |
| `parseCommand(text, botUsername?)`, `toBotCommands(commands)`                | Разбор `/command@bot args`; список команд для меню Telegram.                                                                                                                                                                                                                            |
| `createOwnerNotifier({ client, ownerChatId, logger })`                       | `notify(text)` — сообщение владельцу; никогда не бросает исключение.                                                                                                                                                                                                                    |
| `telegramBotTokenSchema`, `telegramUserIdSchema`, `telegramApiBaseUrlSchema` | Zod-схемы для конфигурации процессов. Base URL: только HTTPS (HTTP — только localhost).                                                                                                                                                                                                 |

## Правила

- Один работающий экземпляр на токен (ограничение long polling).
- Команды, меняющие состояние системы, обязаны запрашивать подтверждение владельца до вызова backend.
- Токен — только из окружения / Secret Manager; никогда не логируется.
