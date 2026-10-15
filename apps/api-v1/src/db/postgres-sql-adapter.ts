import type { PSqlExecutorCounters, PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

/** The postgres.js surface this adapter forwards: a template call returns a thenable, a values call a query fragment. */
export interface PostgresSqlSource {
    <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): PromiseLike<Result>;
    (values: readonly PSqlParameter[]): object;
}

export interface PostgresTransactionSqlSource extends PostgresSqlSource {
    savepoint<T>(write: (transaction: PostgresTransactionSqlSource) => Promise<T>): Promise<T>;
}

export interface PostgresSqlClientSource extends PostgresSqlSource {
    begin<T>(write: (transaction: PostgresTransactionSqlSource) => Promise<T>): Promise<T>;
    notify(channel: string, payload: string): Promise<void | object>;
    listen(channel: string, onMessage: (payload: string) => void | Promise<void>): Promise<void | object>;
    end(): Promise<void>;
}

export interface PostgresSql extends PSqlSql {
    getExecutorCounters(): PSqlExecutorCounters;
    openCounterScope(): PSqlSql;
    notify(channel: string, payload: string): Promise<void | object>;
    listen(channel: string, onMessage: (payload: string) => void | Promise<void>): Promise<void | object>;
    end(): Promise<void>;
}

interface PostgresExecutorCounterState {
    statements: number;
    executorWaitMs: number;
}

/**
 * The executor's state is owned by the root handle and credited by every transaction and savepoint handle; a
 * counter scope adds its own state, which the scoped handle and the transactions it opens report.
 */
interface PostgresCounterBinding {
    readonly credited: readonly PostgresExecutorCounterState[];
    readonly reported: PostgresExecutorCounterState;
}

type PostgresRootSql = PSqlSql & {
    getExecutorCounters(): PSqlExecutorCounters;
    openCounterScope(): PSqlSql;
};

type PostgresTransactionSql = PSqlSql & {
    savepoint<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
};

interface PostgresCountingSql {
    <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    (values: readonly PSqlParameter[]): object;
}

export function createPostgresSqlClient(client: PostgresSqlClientSource): PostgresSql {
    const executorCounters: PostgresExecutorCounterState = { statements: 0, executorWaitMs: 0 };
    return Object.assign(createRootSql(client, { credited: [executorCounters], reported: executorCounters }), {
        notify: (channel: string, payload: string) => client.notify(channel, payload),
        listen: (channel: string, onMessage: (payload: string) => void | Promise<void>) =>
            client.listen(channel, onMessage),
        end: () => client.end()
    });
}

function createRootSql(client: PostgresSqlClientSource, counters: PostgresCounterBinding): PostgresRootSql {
    const sql = createCountingSql(client, counters);
    return Object.assign(sql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
            await unwrapTransactionResult(
                client.begin(async (transaction) => ({
                    value: await write(createTransactionSql(transaction, counters))
                }))
            ),
        getExecutorCounters: (): PSqlExecutorCounters => ({ ...counters.reported }),
        openCounterScope: (): PSqlSql => createRootSql(client, toScopedCounterBinding(counters))
    });
}

function createTransactionSql(
    transaction: PostgresTransactionSqlSource,
    counters: PostgresCounterBinding
): PostgresTransactionSql {
    const sql = createCountingSql(transaction, counters);
    const savepoint = async <T>(write: (nested: PSqlSql) => Promise<T>): Promise<T> =>
        await unwrapTransactionResult(
            transaction.savepoint(async (nested) => ({ value: await write(createTransactionSql(nested, counters)) }))
        );
    return Object.assign(sql, {
        begin: savepoint,
        savepoint,
        getExecutorCounters: (): PSqlExecutorCounters => ({ ...counters.reported }),
        openCounterScope: (): PSqlSql => createTransactionSql(transaction, toScopedCounterBinding(counters))
    });
}

function toScopedCounterBinding(binding: PostgresCounterBinding): PostgresCounterBinding {
    const scope: PostgresExecutorCounterState = { statements: 0, executorWaitMs: 0 };
    return { credited: [...binding.credited, scope], reported: scope };
}

/**
 * postgres.js resolves an array returned from a transaction callback element by element, so the
 * written value travels inside an object and is unwrapped here.
 */
async function unwrapTransactionResult<T>(result: Promise<Readonly<{ value: T; }>>): Promise<T> {
    return (await result).value;
}

function createCountingSql(
    source: PostgresSqlSource,
    counters: PostgresCounterBinding
): PostgresCountingSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateCall(stringsOrValues)) {
            return source(stringsOrValues);
        }
        for (const credited of counters.credited) {
            credited.statements += 1;
        }
        const calledAt = performance.now();
        return Promise.resolve(source<Result>(stringsOrValues, ...values)).finally(() => {
            const waitedMs = performance.now() - calledAt;
            for (const credited of counters.credited) {
                credited.executorWaitMs += waitedMs;
            }
        });
    }
    return sql;
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
