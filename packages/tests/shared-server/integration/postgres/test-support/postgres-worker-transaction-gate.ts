import type { PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

export interface PostgresWorkerTransactionGateTrace {
    barrierWaitCount: number;
}

export interface CreatePostgresWorkerTransactionGateInput {
    readonly sql: PSqlSql;
    readonly beforeMutationTransaction: (() => Promise<void>) | undefined;
    readonly trace: PostgresWorkerTransactionGateTrace;
}

export function createPostgresWorkerTransactionGate(
    input: CreatePostgresWorkerTransactionGateInput
): Readonly<{ sql: PSqlSql; arm(): void; }> {
    let armed = false;
    let consumed = false;
    function gated(values: readonly PSqlParameter[]): object;
    function gated<Rows extends PSqlRows>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Rows>;
    function gated<Rows extends PSqlRows>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Rows> | object {
        return isTemplateStringsArray(stringsOrValues)
            ? input.sql<Rows>(stringsOrValues, ...values)
            : input.sql(stringsOrValues);
    }
    const sql = Object.assign(gated, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            if (armed && !consumed && input.beforeMutationTransaction) {
                consumed = true;
                input.trace.barrierWaitCount += 1;
                await input.beforeMutationTransaction();
            }
            return await input.sql.begin(write);
        }
    });
    return { sql, arm: () => (armed = true) };
}

function isTemplateStringsArray(
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
