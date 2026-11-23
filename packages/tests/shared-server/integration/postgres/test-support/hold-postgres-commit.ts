import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { createPostgresSqlCall } from './create-postgres-sql-call.ts';
import type { WorkerHold } from './postgres-worker-hold.ts';

/**
 * Keeps every transaction open after its write has run: each `begin` runs its write, arrives at the hold and commits
 * only once the hold is released, so a test can act while that transaction's rows are written but uncommitted.
 * Forwards neither optional member of the SQL port (`getExecutorCounters`, a client's `savepoint`).
 */
export function holdPostgresCommit(source: PSqlSql, hold: WorkerHold): PSqlSql {
    return Object.assign(createPostgresSqlCall(source, source), {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
            await source.begin(async (transaction) => {
                const result = await write(transaction);
                await hold.arrive();
                return result;
            })
    });
}

/**
 * Lets every transaction commit, then keeps its caller at the hold: each `begin` returns only once the hold is
 * released, so a test can let several callers' commits all resolve before any of them reads what follows its own.
 * Forwards neither optional member of the SQL port.
 */
export function holdPostgresAfterCommit(source: PSqlSql, hold: WorkerHold): PSqlSql {
    return Object.assign(createPostgresSqlCall(source, source), {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            const result = await source.begin(write);
            await hold.arrive();
            return result;
        }
    });
}
