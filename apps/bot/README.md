# @roi-dealer/bot

Telegram bot. **PHASE 00: только skeleton.** Токен не читается, сетевых вызовов нет: процесс пишет одну структурированную запись о статусе и завершается с кодом 0.

Интеграция с Telegram — PHASE 13+ (Owner Command Center). Будущий Input Router: text / voice / webhook → typed intent → **confirmation** → backend action; state-changing действия только после подтверждения.

Токен бота в будущем — только из Secret Manager / Vault (локально — `.env`), никогда в repository.

```bash
pnpm build && pnpm --filter @roi-dealer/bot start
```
