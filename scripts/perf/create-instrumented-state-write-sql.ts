import type { PSqlSql, PSqlTransactionSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import {
    recordRallarTiming,
    type RallarTimingEvent,
    type RallarTimingSink
} from '@shared-server/rallar-system/services/timing.ts';

export interface StateWriteSqlMetrics {
    statements: number;
    rowsRead: number;
    serializedResultBytes: number;
    readMs: number;
    writeMs: number;
    outboxSqlMs: number;
    transactionDurationMs: number;
}

type PSqlValues = Parameters<PSqlSql>[0];
type PSqlSavepointMethod = <T>(fn: (sql: PSqlTransactionSql) => Promise<T>) => Promise<T>;

export type CreateInstrumentedStateWriteSqlInput = Readonly<{
    sql: PSqlSql;
    metrics: StateWriteSqlMetrics;
    timing: RallarTimingSink;
}>;

export function createInstrumentedStateWriteSql({
    sql,
    metrics,
    timing
}: CreateInstrumentedStateWriteSqlInput): PSqlSql {
    const instrumented = function<T> (
        stringsOrValues: TemplateStringsArray | PSqlValues,
        ...values: PSqlValues
    ): Promise<T> | ReturnType<PSqlSql> {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        const queryText = stringsOrValues.join('?');
        const category = classifyBenchmarkSql(queryText, values);
        const startedAt = performance.now();
        return Promise.resolve(sql<T>(stringsOrValues, ...values)).then(
            (result) => {
                const durationMs = performance.now() - startedAt;
                observeSql({ metrics, category, result, durationMs });
                recordRallarTiming(
                    timing,
                    {
                        component: 'state-write-benchmark-sql',
                        operation: category,
                        details: { statement: firstSqlKeyword(queryText) }
                    },
                    'ok',
                    durationMs
                );
                return result;
            },
            (error) => {
                const durationMs = performance.now() - startedAt;
                observeSql({ metrics, category, result: undefined, durationMs });
                recordRallarTiming(
                    timing,
                    {
                        component: 'state-write-benchmark-sql',
                        operation: category,
                        details: { statement: firstSqlKeyword(queryText) }
                    },
                    'error',
                    durationMs,
                    error
                );
                throw error;
            }
        );
    } as PSqlSql;
    instrumented.begin = async <T>(fn: (transaction: PSqlTransactionSql) => Promise<T>) => {
        const startedAt = performance.now();
        try {
            return await sql.begin(
                async (transaction) => await fn(createInstrumentedStateWriteSql({ sql: transaction, metrics, timing }))
            );
        }
        finally {
            const durationMs = performance.now() - startedAt;
            metrics.transactionDurationMs += durationMs;
            recordRallarTiming(
                timing,
                {
                    component: 'state-write-benchmark-phase',
                    operation: 'transaction'
                },
                'ok',
                durationMs
            );
        }
    };
    const savepoint = (sql as PSqlSql & { savepoint?: PSqlSavepointMethod; }).savepoint;
    if (typeof savepoint === 'function') {
        const invokeSavepoint = savepoint.bind(sql) as PSqlSavepointMethod;
        (instrumented as PSqlSql & { savepoint: PSqlSavepointMethod; }).savepoint = async <T>(
            fn: (transaction: PSqlTransactionSql) => Promise<T>
        ): Promise<T> =>
            await invokeSavepoint<T>(
                async (transaction) => await fn(createInstrumentedStateWriteSql({ sql: transaction, metrics, timing }))
            );
    }
    return instrumented;
}

export function stateWriteProductionPhaseDuration(
    events: readonly RallarTimingEvent[],
    phase: 'read' | 'compute' | 'validate' | 'write' | 'transaction'
): number {
    return events
        .filter(
            (event) =>
                (event.component === 'client-state-service' ||
                    event.component === 'group-state-service' ||
                    event.component === 'group-topology-config-service') &&
                event.operation === `mutation.${phase}`
        )
        .reduce((total, event) => total + event.durationMs, 0);
}

type ObserveSqlInput = Readonly<{
    metrics: StateWriteSqlMetrics;
    category: 'read' | 'write' | 'outbox';
    result: ReturnType<PSqlSql> | undefined;
    durationMs: number;
}>;

function observeSql({ metrics, category, result, durationMs }: ObserveSqlInput): void {
    metrics.statements += 1;
    metrics.serializedResultBytes += byteLength(result);
    if (category === 'read') {
        metrics.rowsRead += Array.isArray(result) ? result.length : 0;
        metrics.readMs += durationMs;
    }
    else if (category === 'outbox') {
        metrics.outboxSqlMs += durationMs;
    }
    else {
        metrics.writeMs += durationMs;
    }
}

export function classifyBenchmarkSql(
    query: string,
    values: PSqlValues
): 'read' | 'write' | 'outbox' {
    const normalized = query.trim().toLowerCase();
    if (
        normalized.includes('resource_inbox') &&
        values.some((value) => value === 'APP_OUTBOX' || value === 'WS_OUTBOX')
    ) {
        return 'outbox';
    }
    return /^(select|show|explain)\b/.test(normalized) ? 'read' : 'write';
}

function firstSqlKeyword(query: string): string {
    return query.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? 'unknown';
}

function isTemplateStringsArray(
    value: TemplateStringsArray | PSqlValues
): value is TemplateStringsArray {
    return Object.hasOwn(value, 'raw');
}

function byteLength(value: ReturnType<PSqlSql> | undefined): number {
    if (value === undefined) {
        return 0;
    }
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    }
    catch {
        return 0;
    }
}
