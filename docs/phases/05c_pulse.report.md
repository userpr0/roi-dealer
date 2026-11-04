# 05c REPORT — «Пульс»: сезоны, события и спрос

> **Спецификация:** [05c_pulse.md](05c_pulse.md). **Основание:** D-030, D-031, [ADR-0012](../ADR/0012-metric-series-and-calendar.md). **Статус:** PASS.

## Implemented

- **Журналы** (миграция `0021_pulse`):
  - `metric_points` — значения рядов спроса по дням;
  - `calendar_events` — праздники, сезоны, регуляторные сроки по рынкам.
  - Только агрегаты, без людей и событий; повторная загрузка обновляет строку.
- **`database.pulse`** (и в транзакции): запись и чтение журналов, проверка входа схемами.
- **Домен:**
  - `interestTrend` — 7 последних дней против 28 до них, только код (§2.13); при нехватке данных — «мало данных»;
  - `addDays`, `PULSE_WINDOW_DAYS = 42`.
- **Сбор** (`@roi-dealer/evidence`):
  - `collectPulse` — те же ворота, что у Evidence: стоп-кран, запись каталога `allowed`, активный доступ интеграции из `/decisions`;
  - `createPulseScheduler` — каждый источник не чаще своего интервала из каталога.
- **Источники:**
  - праздники UK — gov.uk `bank-holidays.json` (OGL v3.0); региональные праздники Шотландии и Северной Ирландии — с пометкой региона;
  - праздники US — расписания OPM на 2026–2027 (общественное достояние; API нет, даты обновляются раз в год);
  - просмотры Википедии по статьям владельца (`PULSE_WIKIPEDIA_ARTICLES`, CC0), с User-Agent и контактом владельца; статья без данных пропускается.
- **Бот:**
  - `/pulse` — 6 недель по рынкам и тренд каждой темы с числами и источником;
  - строка «🔜 Пульс» в дайджесте, когда есть праздник на неделе или растущая тема.
- **Сервер:** `install.sh` и `set-key.sh` передают worker `PUBLIC_CONTACT_EMAIL` и `PULSE_WIKIPEDIA_ARTICLES`; инструкция — [deploy/hetzner.md](../deploy/hetzner.md), «Темы «Пульса»».

## Files created

- `database/migrations/0021_pulse.sql`
- `packages/database/src/pulse.ts`, `packages/domain/src/pulse.ts`, `packages/evidence/src/pulse.ts`, `packages/command-center/src/pulse.ts`
- `tests/support/fake-pulse.ts`, `tests/unit/domain/pulse.test.ts`, `tests/integration/evidence/pulse.test.ts`
- `docs/phases/05c_pulse.md`, `docs/phases/05c_pulse.report.md`, `docs/ADR/0012-metric-series-and-calendar.md`

## Files modified

- `packages/database/src/database.ts`, `index.ts` — `pulse` в базе и транзакции.
- `packages/evidence/src/collect.ts` (экспорт `assertRunning`), `index.ts`; `packages/evidence/src/catalog.ts` — источники праздников.
- `packages/command-center/src/command-center.ts`, `digest.ts`, `index.ts`; `apps/bot/src/commands.ts` — `/pulse`.
- `apps/worker/src/config.ts`, `main.ts` — планировщик «Пульса».
- `infra/hetzner/install.sh`, `set-key.sh`.
- Тесты: `tests/integration/bot/process.test.ts` (меню команд), `tests/integration/worker/process.test.ts` (адреса источников), `tests/integration/database/migrations.test.ts`.

## Tests

- `pnpm test`: 92 файла, 910 тестов — PASS (локально на PostgreSQL 16; в CI — 18).
- `pnpm typecheck`, `lint`, `format:check`, `audit --prod --audit-level=high`, `shellcheck` — PASS.

## Not implemented (Feature Kill Gate)

- Канада — после проверки условий разведчиком (`ca-public-holidays`, домен закрыт сетью среды).
- Австралия — официальный набор data.gov.au пока заканчивается 2025 годом; подключить, когда появится 2026.
- Сезоны и регуляторные сроки — таблица готова, источники — отдельно.
- Google Trends — после одобрения заявки.
- Вес «Пульса» в `scoreOpportunity` — только после проверки на примерах и решения владельца (§2.13).

## What the owner does

1. Одобрить в `/decisions` доступы: UK-праздники, US-праздники, Википедия.
2. По желанию — темы Википедии: `PULSE_WIKIPEDIA_ARTICLES` (названия статей через запятую) и `PUBLIC_CONTACT_EMAIL` у worker.
