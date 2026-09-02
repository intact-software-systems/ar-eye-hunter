import { PGlite } from '@electric-sql/pglite';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';

export interface PGliteSql extends PSqlSql {
    readonly raw: PGlite;
    close(): Promise<void>;
    exec(sql: string): Promise<unknown>;
    notify(channel: string, payload: string): Promise<void>;
    listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
}

export interface PGliteSqlClientOptions {
    readonly ready?: Promise<unknown>;
    readonly stopBeforeClose?: () => Promise<void>;
}

interface PGliteQueryExecutor {
    query<T>(query: string, params?: unknown[]): Promise<{ rows: T[]; }>;
}

interface PGliteSavepointState {
    nextId: number;
}

type PGliteSavepointSql = PSqlSql & {
    savepoint<T>(fn: (sql: PSqlSql) => Promise<T>): Promise<T>;
};

interface PGliteSqlArrayFragment {
    readonly kind: 'array';
    readonly values: readonly unknown[];
}

interface SqlCallableOptions {
    readonly raw: PGlite;
    readonly executor: PGliteQueryExecutor;
    readonly ready: Promise<unknown>;
    readonly inTransaction: boolean;
    readonly savepointState?: PGliteSavepointState;
}

interface PGliteLifecycleOptions {
    readonly raw: PGlite;
    readonly ready: SqlCallableOptions['ready'];
    readonly stopBeforeClose?: () => Promise<void>;
}

interface QueryRowsOptions {
    readonly executor: PGliteQueryExecutor;
    readonly ready: SqlCallableOptions['ready'];
}

interface PGliteRenderedQuery {
    readonly text: string;
    readonly params: NonNullable<Parameters<PGliteQueryExecutor['query']>[1]>;
}

export function createPGliteSqlClient(
    raw: PGlite,
    options: PGliteSqlClientOptions = {}
): PGliteSql {
    const ready = options.ready ?? raw.waitReady;
    const sql = createSqlCallable({
        raw,
        executor: raw,
        ready,
        inTransaction: false
    });

    return attachPGliteLifecycle(sql, {
        raw,
        ready,
        stopBeforeClose: options.stopBeforeClose
    });
}

function createSqlCallable(options: SqlCallableOptions): PSqlSql {
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
    return sql;
}

function attachPGliteBegin(sql: PSqlSql, options: SqlCallableOptions): void {
    sql.begin = async function executePGliteTransaction<T> (
        fn: (transactionSql: PSqlSql) => Promise<T>
    ): Promise<T> {
        await options.ready;

        if (options.inTransaction) {
            return await fn(sql);
        }

        const savepointState: PGliteSavepointState = { nextId: 0 };
        return await options.raw.transaction(async (tx: PGliteQueryExecutor) => {
            const txSql = createSqlCallable({
                raw: options.raw,
                executor: tx,
                ready: options.ready,
                inTransaction: true,
                savepointState
            });

            return await fn(txSql);
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

function attachPGliteLifecycle(sql: PSqlSql, options: PGliteLifecycleOptions): PGliteSql {
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
    options: QueryRowsOptions,
    strings: TemplateStringsArray,
    values: readonly unknown[]
): Promise<readonly Record<string, unknown>[]> {
    await options.ready;
    const query = renderPGliteTemplate(strings, values);
    const result = await options.executor.query<Record<string, unknown>>(
        query.text,
        query.params
    );

    return result.rows;
}

function renderPGliteTemplate(
    strings: TemplateStringsArray,
    values: readonly unknown[]
): PGliteRenderedQuery {
    const textParts: string[] = [];
    const params: unknown[] = [];

    for (let index = 0; index < values.length; index += 1) {
        textParts.push(strings[index]);
        const value = values[index];

        if (isPGliteSqlArrayFragment(value)) {
            if (value.values.length === 0) {
                textParts.push('(null)');
                continue;
            }
            const placeholders = value.values.map((item) => {
                params.push(item);
                return `$${params.length}`;
            });
            textParts.push(`(${placeholders.join(', ')})`);
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
