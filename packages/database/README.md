# @roi-dealer/database

**Статус:** реализован (PHASE 02–04, 13b, [ADR-0005](../../docs/ADR/0005-postgresql-driver-and-migrations.md)).

PostgreSQL для ROI Dealer: пул соединений в UTC, SQL-миграции, репозитории доменных сущностей с событием на каждую запись (PHASE 03), чтение Event History и команды с ключом идемпотентности. Схема — [`database/docs/schema.md`](../../database/docs/schema.md).

## Использование

```ts
import {
  createDatabase,
  createDatabaseHealthCheck,
  loadDatabaseConfig,
} from '@roi-dealer/database';

const config = loadDatabaseConfig(process.env);
const database = createDatabase({
  url: config.DATABASE_URL,
  applicationName: 'roi-dealer-api',
  logger,
});
health.register(createDatabaseHealthCheck(database));
shutdown.register('database', () => database.close());

// Состояние меняет домен; репозиторий сохраняет новую версию, если в БД лежит предыдущая,
// и в той же транзакции пишет событие (кто, когда, какая версия, в рамках какого запроса).
await database.transaction(
  async ({ repositories }) => {
    const opportunity = await repositories.opportunities.getById(id);
    const next = applyOpportunityDecision(opportunity, decision);
    await repositories.decisions.insert(decision);
    await repositories.opportunities.update(next, OWNER);
  },
  { correlationId },
);

// Кнопка в Telegram: повторное нажатие не выполнит действие дважды.
const { outcome, result } = await database.command(
  { name: 'approval.resolve', idempotencyKey: `tg-callback-${callbackId}`, correlationId },
  async ({ repositories }) => {
    /* … */
  },
);

// Журнал за день: события по порядку, постранично.
const page = await database.events.list({ from: dayStart, to: dayEnd, limit: 50 });
```

## Export surface

| Экспорт                                                                                                                      | Назначение                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDatabase`, `Database`                                                                                                 | Пул (`TimeZone=UTC`), `repositories`, `transaction`, `ping`, `close`                                                                                                                                                                                     |
| `createDatabaseHealthCheck`                                                                                                  | Проверка `database` для `HealthRegistry`                                                                                                                                                                                                                 |
| `loadDatabaseConfig`, `databaseConfigShape`                                                                                  | `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_SECONDS`                                                                                                                                                                                  |
| `createRepositories`, `Repositories`                                                                                         | 15 репозиториев (13b — `systemControls`, PHASE 04 — `principals` с `getByActor`): `insert`, `getById`, `getByIds`; у изменяемых ещё `update(entity, actor)` и `listByStatus`; каждая запись проверяет права (`@roi-dealer/policies`) и добавляет событие |
| `Database.transaction(work, { correlationId })`                                                                              | Одна транзакция; все события получают `correlation_id`                                                                                                                                                                                                   |
| `Database.command({ name, idempotencyKey }, work)`                                                                           | Выполнить ровно один раз на ключ; повтор получает сохранённый результат                                                                                                                                                                                  |
| `Database.events`, `EventStore`                                                                                              | `history(aggregate)` — версии сущности; `list({ from, to, aggregateType, after, limit })` — журнал за период                                                                                                                                             |
| `Database.access`, `AccessLog`                                                                                               | Журнал доступа (PHASE 04): `record`, `list` (новые первыми), `count`; отказы записи попадают туда автоматически, даже при откате транзакции                                                                                                              |
| `loadMigrations`, `runMigrations`                                                                                            | Раннер миграций: SHA-256, блокировка, транзакция на файл                                                                                                                                                                                                 |
| `NotFoundError`, `ConcurrencyError`, `ConstraintViolationError`, `DataIntegrityError`, `InvalidWriteError`, `MigrationError` | Ошибки без значений строк                                                                                                                                                                                                                                |

## Правила

- Репозитории принимают и возвращают только доменные объекты; каждая прочитанная строка проверяется доменной схемой (§2.13).
- `update` сохраняет версию `N`, только если в БД лежит версия `N − 1`; иначе `ConcurrencyError`.
- Списки id (связи) только дополняются: удалить или переставить элемент нельзя.
- Сущность сохраняется в версии 1 и дальше каждая версия по очереди: история не имеет пропусков. Запись в обход репозиториев без события БД не зафиксирует.
- Запись разрешена, только если роль актора даёт право на неё, а у `member` / `agent` / `integration` есть активная личность; иначе `DomainError('permission_denied')`. БД дополнительно отклоняет событие без активной личности (`kind: 'access_denied'`).
- `DATABASE_URL` содержит пароль и никогда не логируется.
- CLI: `pnpm db:migrate` (`src/migrate-cli.ts`); в Docker-образе бота — `node /app/node_modules/@roi-dealer/database/dist/migrate-cli.js` с `DATABASE_MIGRATIONS_DIR=/app/database/migrations`.
