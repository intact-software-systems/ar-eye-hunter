import { PSqlFragment } from '@shared-server/postgres/p-sql-fragment.ts';
import type { PSqlExecutorCounters, PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

import type { PostgresStatementCensus } from './postgres-statement-census.ts';

/** postgres.js sends an unprepared statement unnamed, which PostgreSQL plans with its parameters on each execution. */
export interface PostgresUnpreparedStatementOptions {
    readonly prepare: false;
}

/**
 * The postgres.js surface this adapter forwards: a template call returns a thenable, a values call a query fragment,
 * and `unsafe` sends a statement planned per execution as its positional text.
 */
export interface PostgresSqlSource {
    <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): PromiseLike<Result>;
    (values: readonly PSqlParameter[]): object;
    unsafe<Result>(
        text: string,
        values: readonly PSqlParameter[],
        options: PostgresUnpreparedStatementOptions
    ): PromiseLike<Result>;
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

/** A statement planned per execution, as its template call and as its positional text. */
interface PostgresPlannedStatement {
    readonly strings: TemplateStringsArray;
    readonly text: string;
    readonly values: readonly PSqlParameter[];
}

/** How a handle sends a statement planned per execution: unprepared at the root, between plan-cache settings in a transaction. */
type PostgresPlannedStatementStart = <Result>(
    source: PostgresSqlSource,
    statement: PostgresPlannedStatement
) => PromiseLike<Result>;

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
    const sql = createCountingSql(client, recording, startUnpreparedStatement);
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
    const sql = createCountingSql(transaction, recording, startCustomPlannedStatement);
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
    recording: PostgresStatementRecording,
    startPlannedStatement: PostgresPlannedStatementStart
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
        const text = PSqlFragment.getPlannedPerExecutionText(stringsOrValues);
        const pending = text === undefined
            ? source<Result>(stringsOrValues, ...values)
            : startPlannedStatement<Result>(source, { strings: stringsOrValues, text, values });
        return Promise.resolve(pending).finally(() => {
            const executorWaitMs = performance.now() - calledAt;
            counters.executorWaitMs += executorWaitMs;
            census?.record({ strings: stringsOrValues, values, executorWaitMs });
        });
    }
    return sql;
}

/**
 * postgres.js sends an unprepared statement with parameters as two round trips, a describe and then the execution; in
 * auto-commit there is no transaction a plan-cache setting could be scoped to.
 */
function startUnpreparedStatement<Result>(
    source: PostgresSqlSource,
    { text, values }: PostgresPlannedStatement
): PromiseLike<Result> {
    PSqlFragment.assertPositionalParameters(values);
    return source.unsafe<Result>(text, values, { prepare: false });
}

/**
 * The prepared statement between two transaction-scoped plan-cache settings, issued together so postgres.js pipelines
 * them in one write: one round trip, and a plan built with this execution's parameters. The settings are not counted.
 */
async function startCustomPlannedStatement<Result>(
    source: PostgresSqlSource,
    { strings, values }: PostgresPlannedStatement
): Promise<Result> {
    const [, result] = await Promise.all([
        source`set local plan_cache_mode = force_custom_plan`,
        source<Result>(strings, ...values),
        source`set local plan_cache_mode = default`
    ]);
    return result;
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
