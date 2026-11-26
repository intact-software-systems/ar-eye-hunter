import type { PSqlParameter, PSqlSql, PSqlTransactionWrite } from '@shared-server/postgres/p-sql-sql.ts';

export interface CreateDelayedPSqlSqlInput {
    readonly sql: PSqlSql;
    /** What one round trip to the database costs on top of the handle's own time; 0 adds nothing. */
    readonly delayMs: number;
    readonly sleep: (delayMs: number) => Promise<void>;
}

type PSqlSavepointSql = PSqlSql & {
    savepoint<T>(write: PSqlTransactionWrite<T>): Promise<T>;
};

/**
 * A handle that models network latency to the database: every round trip through it, and through the transactions
 * and savepoints it opens, first waits `delayMs`. A statement is one round trip. A transaction is one at BEGIN,
 * before `sql.begin` takes a connection, one for each of its statements, and one after `sql.begin` settled, for its
 * COMMIT or ROLLBACK; a savepoint is delayed the same way. A values call builds a fragment and sends nothing, so it
 * is not delayed. At 0 ms the handle given is returned as it is.
 */
export function createDelayedPSqlSql(input: CreateDelayedPSqlSqlInput): PSqlSql {
    return input.delayMs === 0 ? input.sql : toDelayedSql(input.sql, async () => await input.sleep(input.delayMs));
}

function toDelayedSql(source: PSqlSql, delayRoundTrip: () => Promise<void>): PSqlSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateCall(stringsOrValues)) {
            return source(stringsOrValues);
        }
        return delayRoundTrip().then(() => source<Result>(stringsOrValues, ...values));
    }
    const delayed: PSqlSql = Object.assign(sql, {
        begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
            await runBetweenDelayedRoundTrips(
                delayRoundTrip,
                async () =>
                    await source.begin(async (transaction) => await write(toDelayedSql(transaction, delayRoundTrip)))
            )
    });
    if (source.getExecutorCounters) {
        delayed.getExecutorCounters = source.getExecutorCounters.bind(source);
    }
    if (!hasSavepoint(source)) {
        return delayed;
    }
    return Object.assign(delayed, {
        savepoint: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
            await runBetweenDelayedRoundTrips(
                delayRoundTrip,
                async () => await source.savepoint(async (nested) => await write(toDelayedSql(nested, delayRoundTrip)))
            )
    });
}

/** The round trip that opens a transaction or a savepoint, and the one that commits it or rolls it back. */
async function runBetweenDelayedRoundTrips<T>(
    delayRoundTrip: () => Promise<void>,
    runScope: () => Promise<T>
): Promise<T> {
    await delayRoundTrip();
    try {
        return await runScope();
    }
    finally {
        await delayRoundTrip();
    }
}

function hasSavepoint(sql: PSqlSql): sql is PSqlSavepointSql {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
