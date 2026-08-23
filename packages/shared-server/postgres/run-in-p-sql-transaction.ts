import type { PSqlSql } from './p-sql-sql.ts';

export async function runInPSqlTransaction<T>(
    database: PSqlSql,
    write: (transaction: PSqlSql) => Promise<T>
): Promise<T> {
    return await database.begin(write);
}
