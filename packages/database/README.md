# @roi-dealer/database

**Статус:** реализован (PHASE 02, [ADR-0005](../../docs/ADR/0005-postgresql-driver-and-migrations.md)).

PostgreSQL для ROI Dealer: пул соединений в UTC, SQL-миграции и репозитории сущностей PHASE 01. Схема — [`database/docs/schema.md`](../../database/docs/schema.md).

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

// Состояние меняет домен; репозиторий сохраняет новую версию, если в БД лежит предыдущая.
await database.transaction(async ({ repositories }) => {
  const opportunity = await repositories.opportunities.getById(id);
  const next = applyOpportunityDecision(opportunity, decision);
  await repositories.decisions.insert(decision);
  await repositories.opportunities.update(next);
});
```

## Export surface

| Экспорт                                                                                                 | Назначение                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `createDatabase`, `Database`                                                                            | Пул (`TimeZone=UTC`), `repositories`, `transaction`, `ping`, `close`                  |
| `createDatabaseHealthCheck`                                                                             | Проверка `database` для `HealthRegistry`                                              |
| `loadDatabaseConfig`, `databaseConfigShape`                                                             | `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_CONNECT_TIMEOUT_SECONDS`               |
| `createRepositories`, `Repositories`                                                                    | 13 репозиториев: `insert`, `getById`, `getByIds`; у изменяемых сущностей ещё `update` |
| `loadMigrations`, `runMigrations`                                                                       | Раннер миграций: SHA-256, блокировка, транзакция на файл                              |
| `NotFoundError`, `ConcurrencyError`, `ConstraintViolationError`, `DataIntegrityError`, `MigrationError` | Ошибки без значений строк                                                             |

## Правила

- Репозитории принимают и возвращают только доменные объекты; каждая прочитанная строка проверяется доменной схемой (§2.13).
- `update` сохраняет версию `N`, только если в БД лежит версия `N − 1`; иначе `ConcurrencyError`.
- Списки id (связи) только дополняются: удалить или переставить элемент нельзя.
- `DATABASE_URL` содержит пароль и никогда не логируется.
- CLI: `pnpm db:migrate` (`src/migrate-cli.ts`).
