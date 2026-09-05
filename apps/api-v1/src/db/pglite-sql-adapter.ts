import { PGlite } from '@electric-sql/pglite';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

type PGliteQueryExecutor = Readonly<{
    query<T>(
        query: string,
        params?: unknown[],
        options?: PGliteQueryOptions
    ): Promise<{ rows: T[]; }>;
}>;

type PGliteQueryOptions = Readonly<{
    parsers?: Readonly<Record<number, (value: string) => string>>;
}>;

type PGliteSavepointState = {
    nextId: number;
};

type PGliteSavepointSql = PSqlSql & {
    savepoint<T>(fn: (sql: PSqlSql) => Promise<T>): Promise<T>;
};

type PGliteSqlArrayFragment = Readonly<{
    kind: 'array';
    values: readonly unknown[];
}>;

const POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;
const PGLITE_QUERY_OPTIONS: PGliteQueryOptions = {
    parsers: {
        [POSTGRES_TIMESTAMP_WITHOUT_TIME_ZONE_OID]: (value) => value
    }
};

type SqlCallableOptions = Readonly<{
    raw: PGlite;
    executor: PGliteQueryExecutor;
    ready: Promise<unknown>;
    stopBeforeClose?: () => Promise<void>;
    inTransaction: boolean;
    savepointState?: PGliteSavepointState;
}>;

export type PGliteSql = PSqlSql & {
    readonly raw: PGlite;
    close(): Promise<void>;
    exec(sql: string): Promise<unknown>;
    notify(channel: string, payload: string): Promise<void>;
    listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
};

export type PGliteSqlClientOptions = Readonly<{
    ready?: Promise<unknown>;
    stopBeforeClose?: () => Promise<void>;
}>;

export function createPGliteSqlClient(
    raw: PGlite,
    options: PGliteSqlClientOptions = {}
): PGliteSql {
    const ready = options.ready ?? raw.waitReady;
    return createSqlCallable({
        raw,
        executor: raw,
        ready,
        stopBeforeClose: options.stopBeforeClose,
        inTransaction: false
    }) as PGliteSql;
}

function createSqlCallable(options: SqlCallableOptions): PSqlSql | PGliteSql {
    const sql = ((
        stringsOrValues: TemplateStringsArray | readonly unknown[],
        ...values: unknown[]
    ): Promise<unknown> | PGliteSqlArrayFragment => {
        if (!isTemplateCall(stringsOrValues)) {
            return {
                kind: 'array',
                values: stringsOrValues
            };
        }

        return queryRows(options, stringsOrValues, values);
    }) as PSqlSql;

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
        await options.executor.query(`savepoint ${savepointName}`);
        try {
            const result = await fn(savepointSql);
            await options.executor.query(`release savepoint ${savepointName}`);
            return result;
        }
        catch (error) {
            await options.executor.query(`rollback to savepoint ${savepointName}`);
            await options.executor.query(`release savepoint ${savepointName}`);
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
            return await options.raw.exec(query);
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
    options: Readonly<{
        executor: PGliteQueryExecutor;
        ready: Promise<unknown>;
    }>,
    strings: TemplateStringsArray,
    values: readonly unknown[]
): Promise<readonly Record<string, unknown>[]> {
    await options.ready;
    const query = renderPGliteTemplate(strings, values);
    const result = await options.executor.query<Record<string, unknown>>(
        query.text,
        query.params,
        PGLITE_QUERY_OPTIONS
    );

    return result.rows;
}

function renderPGliteTemplate(
    strings: TemplateStringsArray,
    values: readonly unknown[]
): Readonly<{ text: string; params: unknown[]; }> {
    const textParts: string[] = [];
    const params: unknown[] = [];

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
    params: unknown[]
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

function isPGliteSqlArrayFragment(value: unknown): value is PGliteSqlArrayFragment {
    return Boolean(
        value &&
            typeof value === 'object' &&
            (value as PGliteSqlArrayFragment).kind === 'array' &&
            Array.isArray((value as PGliteSqlArrayFragment).values)
    );
}

function isTemplateCall(value: unknown): value is TemplateStringsArray {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw');
}
