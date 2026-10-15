import { PGlite } from '@electric-sql/pglite';
import type { PSqlExecutorCounters, PSqlParameter, PSqlRows, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';

type PGliteQueryExecutor = Readonly<{
    query<T>(
        query: string,
        params?: readonly PSqlParameter[],
        options?: PGliteQueryOptions
    ): Promise<{ rows: T[]; }>;
}>;

type PGliteQueryOptions = Readonly<{
    parsers?: Readonly<Record<number, (value: string) => string>>;
}>;

type PGliteSavepointState = {
    nextId: number;
};

interface PGliteExecutorCounterState {
    statements: number;
    executorWaitMs: number;
}

/**
 * The executor's state is owned by the root handle and credited by every handle; a counter scope adds its own
 * state, which the scoped handle and the transactions it opens report.
 */
interface PGliteCounterBinding {
    readonly credited: readonly PGliteExecutorCounterState[];
    readonly reported: PGliteExecutorCounterState;
}

type PGliteSavepointSql = PSqlSql & {
    savepoint<T>(fn: (sql: PSqlSql) => Promise<T>): Promise<T>;
};

type PGliteSqlArrayFragment = Readonly<{
    kind: 'array';
    values: readonly PSqlParameter[];
}>;

const PGLITE_QUERY_OPTIONS: PGliteQueryOptions = {
    parsers: {
        [POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID]: (value) => value
    }
};

type SqlCallableOptions = Readonly<{
    raw: PGlite;
    executor: PGliteQueryExecutor;
    ready: Promise<void>;
    counters: PGliteCounterBinding;
    stopBeforeClose?: () => Promise<void>;
    inTransaction: boolean;
    savepointState?: PGliteSavepointState;
}>;

export type PGliteSql = PSqlSql & {
    readonly raw: PGlite;
    close(): Promise<void>;
    exec(sql: string): Promise<void>;
    notify(channel: string, payload: string): Promise<void>;
    listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
};

export type PGliteSqlClientOptions = Readonly<{
    ready?: Promise<void>;
    stopBeforeClose?: () => Promise<void>;
}>;

export function createPGliteSqlClient(
    raw: PGlite,
    options: PGliteSqlClientOptions = {}
): PGliteSql {
    const ready = options.ready ?? raw.waitReady;
    const executorCounters: PGliteExecutorCounterState = { statements: 0, executorWaitMs: 0 };
    return createSqlCallable({
        raw,
        executor: raw,
        ready,
        counters: { credited: [executorCounters], reported: executorCounters },
        stopBeforeClose: options.stopBeforeClose,
        inTransaction: false
    }) as PGliteSql;
}

function createSqlCallable(options: SqlCallableOptions): PSqlSql | PGliteSql {
    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<PSqlRows> | PGliteSqlArrayFragment => {
        if (!isTemplateCall(stringsOrValues)) {
            return {
                kind: 'array',
                values: stringsOrValues
            };
        }

        return queryRows(options, stringsOrValues, values);
    }) as PSqlSql;

    sql.getExecutorCounters = (): PSqlExecutorCounters => ({ ...options.counters.reported });
    sql.openCounterScope = (): PSqlSql =>
        createSqlCallable({ ...options, counters: toScopedCounterBinding(options.counters) }) as PSqlSql;
    attachPGliteBegin(sql, options);
    attachPGliteSavepoint(sql, options);
    return attachPGliteLifecycle(sql, options);
}

function attachPGliteBegin(sql: PSqlSql, options: SqlCallableOptions): void {
    sql.begin = async <T>(fn: (transactionSql: PSqlSql) => Promise<T>): Promise<T> => {
        await options.ready;

        if (options.inTransaction) {
            return await fn(sql as PSqlSql);
        }

        return await options.raw.transaction(async (tx: PGliteQueryExecutor) => {
            const txSql = createSqlCallable({
                raw: options.raw,
                executor: tx,
                ready: Promise.resolve(),
                counters: options.counters,
                inTransaction: true,
                savepointState: { nextId: 0 }
            });

            return await fn(txSql as PSqlSql);
        });
    };
}

function attachPGliteSavepoint(sql: PSqlSql, options: SqlCallableOptions): void {
    if (!options.inTransaction) {
        return;
    }
    const savepointState = options.savepointState;
    if (!savepointState) {
        throw new Error('PGlite transaction SQL requires savepoint state.');
    }
    const savepointSql = sql as PGliteSavepointSql;
    savepointSql.savepoint = async <T>(
        fn: (transactionSql: PSqlSql) => Promise<T>
    ): Promise<T> => {
        const savepointName = `rallar_savepoint_${savepointState.nextId}`;
        savepointState.nextId += 1;
        await executeCountedStatement(options, `savepoint ${savepointName}`);
        try {
            const result = await fn(savepointSql);
            await executeCountedStatement(options, `release savepoint ${savepointName}`);
            return result;
        }
        catch (error) {
            await executeCountedStatement(options, `rollback to savepoint ${savepointName}`);
            await executeCountedStatement(options, `release savepoint ${savepointName}`);
            throw error;
        }
    };
}

function attachPGliteLifecycle(sql: PSqlSql, options: SqlCallableOptions): PGliteSql {
    return Object.assign(sql, {
        raw: options.raw,
        close: async () => {
            try {
                await options.stopBeforeClose?.();
                await options.ready;
            }
            finally {
                await options.raw.close();
            }
        },
        exec: async (query: string) => {
            await options.ready;
            await options.raw.exec(query);
        },
        notify: async (channel: string, payload: string) => {
            await options.ready;
            await options.raw.query('select pg_notify($1, $2)', [channel, payload]);
        },
        listen: async (channel: string, callback: (payload: string) => void) => {
            await options.ready;
            return await options.raw.listen(channel, callback);
        }
    });
}

async function queryRows(
    options: SqlCallableOptions,
    strings: TemplateStringsArray,
    values: readonly PSqlParameter[]
): Promise<PSqlRows> {
    await options.ready;
    const query = renderPGliteTemplate(strings, values);
    const result = await executeCountedStatement<object>(options, query.text, query.params);

    return result.rows;
}

async function executeCountedStatement<T>(
    options: Pick<SqlCallableOptions, 'executor' | 'counters'>,
    text: string,
    params: readonly PSqlParameter[] = []
): Promise<{ rows: T[]; }> {
    for (const counters of options.counters.credited) {
        counters.statements += 1;
    }
    const calledAt = performance.now();
    try {
        return await options.executor.query<T>(text, params, PGLITE_QUERY_OPTIONS);
    }
    finally {
        const waitedMs = performance.now() - calledAt;
        for (const counters of options.counters.credited) {
            counters.executorWaitMs += waitedMs;
        }
    }
}

function toScopedCounterBinding(binding: PGliteCounterBinding): PGliteCounterBinding {
    const scope: PGliteExecutorCounterState = { statements: 0, executorWaitMs: 0 };
    return { credited: [...binding.credited, scope], reported: scope };
}

function renderPGliteTemplate(
    strings: TemplateStringsArray,
    values: readonly PSqlParameter[]
): Readonly<{ text: string; params: readonly PSqlParameter[]; }> {
    const textParts: string[] = [];
    const params: PSqlParameter[] = [];

    for (let index = 0; index < values.length; index += 1) {
        textParts.push(strings[index]);
        const value = values[index];

        if (isPGliteSqlArrayFragment(value)) {
            textParts.push(renderArrayFragment(value, params));
            continue;
        }

        params.push(value);
        textParts.push(`$${params.length}`);
    }

    textParts.push(strings[strings.length - 1]);
    return {
        text: textParts.join(''),
        params
    };
}

function renderArrayFragment(
    fragment: PGliteSqlArrayFragment,
    params: PSqlParameter[]
): string {
    if (fragment.values.length === 0) {
        return '(null)';
    }

    const placeholders = fragment.values.map((value) => {
        params.push(value);
        return `$${params.length}`;
    });

    return `(${placeholders.join(', ')})`;
}

function isPGliteSqlArrayFragment(value: PSqlParameter): value is PGliteSqlArrayFragment {
    return Boolean(
        value &&
            typeof value === 'object' &&
            (value as PGliteSqlArrayFragment).kind === 'array' &&
            Array.isArray((value as PGliteSqlArrayFragment).values)
    );
}

function isTemplateCall(value: TemplateStringsArray | readonly PSqlParameter[]): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
