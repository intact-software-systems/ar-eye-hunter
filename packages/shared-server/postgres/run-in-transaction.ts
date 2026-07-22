import type { PSqlSql, PSqlTransactionSql } from './PostgresSqlClient.ts';

export async function runInTransaction<T>(
    database: PSqlSql,
    write: (transaction: PSqlTransactionSql) => Promise<T>,
): Promise<T> {
    return await database.begin(write);
}
