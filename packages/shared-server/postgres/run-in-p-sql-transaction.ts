import type { PSqlSql, PSqlTransactionWrite } from './p-sql-sql.ts';

export async function runInPSqlTransaction<T>(
    database: PSqlSql,
    write: PSqlTransactionWrite<T>
): Promise<T> {
    return await database.begin(write);
}
