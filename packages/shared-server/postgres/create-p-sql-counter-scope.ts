import type { PSqlExecutorCounters, PSqlParameter, PSqlSql, PSqlTransactionWrite } from './p-sql-sql.ts';

interface PSqlCounterScopeState {
    statements: number;
    executorWaitMs: number;
    beginWaitMs: number;
}

type PSqlSavepointSql = PSqlSql & {
    savepoint<T>(write: PSqlTransactionWrite<T>): Promise<T>;
};

/**
 * A handle that counts the statements issued through it and through the transactions and savepoints it opens,
 * and hands every call to `database`: a transaction it opens is `database.begin` itself, so whatever that
 * handle does at begin, commit or rollback applies unchanged. The wait is each statement's call-to-completion
 * time, as `PSqlExecutorCounters` defines it; statements other callers issue never credit the scope. It also
 * sums the time each `begin` waits before its transaction callback is entered.
 */
export function createPSqlCounterScope(database: PSqlSql): PSqlSql {
    return toCountedSql(database, { statements: 0, executorWaitMs: 0, beginWaitMs: 0 });
}

function toCountedSql(source: PSqlSql, scope: PSqlCounterScopeState): PSqlSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateCall(stringsOrValues)) {
            return source(stringsOrValues);
        }
        scope.statements += 1;
        const calledAt = performance.now();
        return Promise.resolve(source<Result>(stringsOrValues, ...values)).finally(() => {
            scope.executorWaitMs += performance.now() - calledAt;
        });
    }
    const counted: PSqlSql = Object.assign(sql, {
        begin: async <T>(write: PSqlTransactionWrite<T>): Promise<T> => {
            const calledAt = performance.now();
            return await source.begin(async (transaction) => {
                scope.beginWaitMs += performance.now() - calledAt;
                return await write(toCountedSql(transaction, scope));
            });
        },
        getExecutorCounters: (): PSqlExecutorCounters => ({ ...scope })
    });
    if (!hasSavepoint(source)) {
        return counted;
    }
    return Object.assign(counted, {
        savepoint: async <T>(write: PSqlTransactionWrite<T>): Promise<T> =>
            await source.savepoint(async (nested) => await write(toCountedSql(nested, scope)))
    });
}

function hasSavepoint(sql: PSqlSql): sql is PSqlSavepointSql {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
