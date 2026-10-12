import type postgres from 'postgres';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

/** Where queries run: the connection pool or an open transaction. */
export type Executor = Sql | TransactionSql;

/** A stored row as returned by the driver. */
export type Row = Readonly<Record<string, unknown>>;

function isTransaction(executor: Executor): executor is TransactionSql {
  return 'savepoint' in executor;
}

/**
 * Runs `work` atomically: in a new transaction on the pool, or in a savepoint when the
 * executor is already a transaction, so repository writes compose into larger transactions.
 */
export async function atomic<T>(
  executor: Executor,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const result = isTransaction(executor)
    ? await executor.savepoint(work)
    : await executor.begin(work);
  return result as T;
}
