import type { PSqlSql } from './p-sql-sql.ts';

/** All readers see one MVCC snapshot. PostgreSQL enforces the read-only transaction, including nested repository calls. */
export async function readPostgresSnapshot<Value>(
    database: PSqlSql,
    read: (transaction: PSqlSql) => Promise<Value>
): Promise<Value> {
    return await database.begin(async (transaction) => {
        await transaction`set transaction isolation level repeatable read, read only`;
        return await read(transaction);
    });
}
