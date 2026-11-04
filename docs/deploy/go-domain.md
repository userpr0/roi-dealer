# Страницы тестов на go.roidealer.com

Сайт `roidealer.com` остаётся как есть (Lovable). Страницы тестов, `/privacy` и пульт открываются с поддомена `go.roidealer.com` — его обслуживает наш сервис `api` в Railway.

1. **Railway** → проект → сервис `api` → Settings → Networking → **Custom Domain** → `go.roidealer.com`. Railway покажет запись CNAME (адрес вида `xxxx.up.railway.app`).
2. **Cloudflare** (DNS домена `roidealer.com`) → DNS → Add record:
   - Type `CNAME`, Name `go`, Target — адрес из Railway;
   - Proxy status — **DNS only** (серое облако), иначе Railway не выпустит сертификат.
3. Подождите, пока Railway покажет у домена зелёную галочку (обычно до 30 минут).
4. **Railway** → сервис `bot` → Variables → `PUBLIC_API_URL=https://go.roidealer.com` → бот перезапустится; ссылки на страницы тестов и кнопка «Пульт» перейдут на новый адрес.
5. Проверка: откройте `https://go.roidealer.com/health` — ответ `ok`; `https://go.roidealer.com/privacy` — политика конфиденциальности.

Старый адрес Railway продолжает работать; уже опубликованные ссылки не ломаются.
