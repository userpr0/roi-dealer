# 05b REPORT — Новые источники данных. Часть 1: второй источник болей

> **Спецификация:** [05b_sources.md](05b_sources.md). **Основание:** D-026. **Статус:** PASS.

## Implemented

- **Разведчик источников, два запуска 20.10.2026** — [отчёт](../sources/scout-2026-10-20.md). Каталог — архив из 48 источников с цитатами условий: 21 разрешён, 10 требуют договора или одобрения, 8 отклонены, 9 ждут проверки. В боте его показывает `/sources`.
- **Коннектор Lemmy** (`createLemmyConnector`, `@roi-dealer/evidence`):
  - официальный API lemmy.world, новые посты сообществ `asklemmy`, `nostupidquestions`, `selfhosted`;
  - берёт только посты, созданные на lemmy.world, на английском или без языка; удалённые, снятые и NSFW пропускает;
  - автора не читает; текст проходит обычную очистку движка.
- **Worker** собирает Lemmy вторым источником (`LEMMY_API_URL`, по умолчанию lemmy.world). Сбор начинается после одобрения владельцем в `/decisions`.

## Files created

- `packages/evidence/src/lemmy.ts`
- `tests/support/fake-lemmy.ts`
- `tests/integration/evidence/lemmy.test.ts`
- `docs/phases/05b_sources.md`, `docs/phases/05b_sources.report.md`

## Files modified

- `packages/evidence/src/index.ts` — экспорт коннектора.
- `packages/evidence/src/catalog.ts` — лимит и условие записи `lemmy-world`.
- `apps/worker/src/config.ts`, `apps/worker/src/main.ts` — `LEMMY_API_URL`, второй коннектор.
- `tests/integration/worker/process.test.ts` — адрес Lemmy, который тест не одобряет.
- `packages/evidence/README.md`, `docs/CURRENT_STATE.md`, `docs/ROADMAP.md`.

## Database migrations

Нет: посты Lemmy ложатся в существующие `evidence` и `source_snapshots`.

## Tests added

`tests/integration/evidence/lemmy.test.ts`:

- коннектор берёт новые посты трёх сообществ и пропускает чужие, удалённые, снятые, NSFW и неанглийские; автор не попадает в результат; хэш покрывает все ответы;
- повторная загрузка не берёт сохранённые посты, лимит загрузки соблюдается;
- сбой источника — `fetch_failed`;
- через движок: до одобрения ни одного запроса; после — Evidence с очищенной почтой, без автора в Evidence, событиях и логах.

## Test results

`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (89 файлов, 892 теста), `pnpm build` — зелёные.

## Security implications

- Новых секретов нет.
- Автор поста не читается: поля `creator` нет в схеме ответа.
- Ссылка ведёт на пост, не на профиль.

## Cost implications

Нет: API бесплатный. Расход AI растёт на разбор новых постов — в пределах дневной квоты (D-021).

## Known limitations

- Сообщества заданы в коде. Список меняется вместе с проверкой, что в сообществе есть боли.
- Посты из этих сообществ, созданные на других серверах Lemmy, не собираются: их условия не проверены.

## Technical debt

Нет.

## Architecture deviations

Нет.

## Scope decisions

- Bluesky — часть 2: нужны пароль приложения владельца и удаление фрагмента по просьбе автора.
- Ряды чисел — часть 3: сначала ADR о хранении рядов и их вкладе в оценку.

## Ready for next phase

Да. После деплоя: `/decisions` → «Доступ: Lemmy (lemmy.world)» → ✅ → **Да**.
