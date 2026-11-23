import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import { createPostgresSqlCall } from './create-postgres-sql-call.ts';

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
    const sql = Object.assign(createPostgresSqlCall(input.sql, input.sql), {
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
