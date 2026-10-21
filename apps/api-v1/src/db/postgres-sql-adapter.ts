import type { PSqlExecutorCounters, PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import type { PostgresStatementCensus } from './postgres-statement-census.ts';

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
    notify(channel: string, payload: string): Promise<void | object>;
    listen(channel: string, onMessage: (payload: string) => void | Promise<void>): Promise<void | object>;
    end(): Promise<void>;
}

/** Owned by the root handle and shared with every transaction and savepoint handle it opens. */
interface PostgresExecutorCounterState {
    statements: number;
    executorWaitMs: number;
}

/** What every handle of one client records into: its counters, and the census while timing is on. */
interface PostgresStatementRecording {
    readonly counters: PostgresExecutorCounterState;
    readonly census: PostgresStatementCensus | undefined;
}

type PostgresTransactionSql = PSqlSql & {
    savepoint<T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T>;
};

interface PostgresCountingSql {
    <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    (values: readonly PSqlParameter[]): object;
}

/** The census, when given, records every statement of the client and of the transactions it opens. */
export function createPostgresSqlClient(
    client: PostgresSqlClientSource,
    census: PostgresStatementCensus | undefined
): PostgresSql {
    const recording: PostgresStatementRecording = { counters: { statements: 0, executorWaitMs: 0 }, census };
    const sql = createCountingSql(client, recording);
    return Object.assign(sql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
            await unwrapTransactionResult(
                client.begin(async (transaction) => ({
                    value: await write(createTransactionSql(transaction, recording))
                }))
            ),
        getExecutorCounters: (): PSqlExecutorCounters => ({ ...recording.counters }),
        notify: (channel: string, payload: string) => client.notify(channel, payload),
        listen: (channel: string, onMessage: (payload: string) => void | Promise<void>) =>
            client.listen(channel, onMessage),
        end: () => client.end()
    });
}

function createTransactionSql(
    transaction: PostgresTransactionSqlSource,
    recording: PostgresStatementRecording
): PostgresTransactionSql {
    const sql = createCountingSql(transaction, recording);
    const savepoint = async <T>(write: (nested: PSqlSql) => Promise<T>): Promise<T> =>
        await unwrapTransactionResult(
            transaction.savepoint(async (nested) => ({ value: await write(createTransactionSql(nested, recording)) }))
        );
    return Object.assign(sql, {
        begin: savepoint,
        savepoint,
        getExecutorCounters: (): PSqlExecutorCounters => ({ ...recording.counters })
    });
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
    recording: PostgresStatementRecording
): PostgresCountingSql {
    const { counters, census } = recording;
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateCall(stringsOrValues)) {
            return source(stringsOrValues);
        }
        counters.statements += 1;
        const calledAt = performance.now();
        return Promise.resolve(source<Result>(stringsOrValues, ...values)).finally(() => {
            const executorWaitMs = performance.now() - calledAt;
            counters.executorWaitMs += executorWaitMs;
            census?.record({ strings: stringsOrValues, values, executorWaitMs });
        });
    }
    return sql;
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
