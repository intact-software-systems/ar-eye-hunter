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
 * and savepoints it opens, costs one wait of `delayMs`. At 0 ms the handle given is returned as it is.
 *
 * - A statement waits before it is sent. A values call builds a fragment and sends nothing, so it never waits.
 * - A transaction waits twice inside itself, on the connection `sql.begin` took for it: once after BEGIN, before
 *   its first statement, and once after its write settled, before COMMIT or ROLLBACK. The first stands for the way
 *   back of BEGIN's answer and the second for the way out of COMMIT or ROLLBACK, each counted as a whole round
 *   trip. So a transaction of `n` statements costs `(n + 2) * delayMs`, and holds its connection and every lock it
 *   took through all of it, as it would over a link with that round-trip time. The wait for a free connection
 *   comes before BEGIN and is never part of it.
 * - A savepoint, which is also what `begin` on a transaction's handle opens, waits before it opens. postgres.js
 *   sends nothing more when its write resolves and one ROLLBACK TO when it rejects, so it waits again only then,
 *   after the rejection; the transaction around it holds the connection either way.
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
    const counters = source.getExecutorCounters === undefined
        ? {}
        : { getExecutorCounters: source.getExecutorCounters.bind(source) };
    if (!hasSavepoint(source)) {
        return Object.assign(sql, counters, {
            begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
                await runDelayedTransaction(source, delayRoundTrip, write)
        });
    }
    return Object.assign(sql, counters, {
        begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
            await runDelayedSavepoint(async (nestedWrite) => await source.begin(nestedWrite), delayRoundTrip, write),
        savepoint: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
            await runDelayedSavepoint(async (nestedWrite) => await source.savepoint(nestedWrite), delayRoundTrip, write)
    });
}

async function runDelayedTransaction<T>(
    source: PSqlSql,
    delayRoundTrip: () => Promise<void>,
    write: PSqlTransactionWrite<T>
): Promise<T> {
    return await source.begin(async (transaction) => {
        await delayRoundTrip();
        try {
            return await write(toDelayedSql(transaction, delayRoundTrip));
        }
        finally {
            await delayRoundTrip();
        }
    });
}

async function runDelayedSavepoint<T>(
    openSavepoint: (write: PSqlTransactionWrite<T>) => Promise<T>,
    delayRoundTrip: () => Promise<void>,
    write: PSqlTransactionWrite<T>
): Promise<T> {
    await delayRoundTrip();
    try {
        return await openSavepoint(async (nested) => await write(toDelayedSql(nested, delayRoundTrip)));
    }
    catch (error) {
        await delayRoundTrip();
        throw error;
    }
}

function hasSavepoint(sql: PSqlSql): sql is PSqlSavepointSql {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.hasOwn(value, 'raw');
}
