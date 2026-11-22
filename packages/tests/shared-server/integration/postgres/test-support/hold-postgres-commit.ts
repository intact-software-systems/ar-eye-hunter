import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import type { WorkerHold } from './postgres-worker-hold.ts';

/**
 * Keeps every transaction open after its write has run: each `begin` runs its write, arrives at the hold and commits
 * only once the hold is released, so a test can act while that transaction's rows are written but uncommitted.
 */
export function holdPostgresCommit(source: PSqlSql, hold: WorkerHold): PSqlSql {
    function held<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function held(values: readonly PSqlParameter[]): object;
    function held<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        return Object.hasOwn(stringsOrValues, 'raw')
            ? source<Result>(stringsOrValues as TemplateStringsArray, ...values)
            : source(stringsOrValues as readonly PSqlParameter[]);
    }
    return Object.assign(held, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
            await source.begin(async (transaction) => {
                const result = await write(transaction);
                await hold.arrive();
                return result;
            })
    });
}
