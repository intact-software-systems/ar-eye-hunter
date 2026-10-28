import type { PSqlParameter, PSqlSql, PSqlTransactionWrite } from '@shared-server/postgres/p-sql-sql.ts';
import {
    recordRallarTiming,
    type RallarTimingEvent,
    type RallarTimingSink
} from '@shared-server/rallar-system/observability/timing.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface StateWriteSqlMetrics {
    statements: number;
    rowsRead: number;
    serializedResultBytes: number;
    readMs: number;
    writeMs: number;
    outboxSqlMs: number;
    transactionDurationMs: number;
}

export interface CreateInstrumentedStateWriteSqlInput {
    readonly sql: PSqlSql;
    readonly metrics: StateWriteSqlMetrics;
    readonly timing: RallarTimingSink;
}

interface PSqlSavepointSql extends PSqlSql {
    savepoint<Result>(write: PSqlTransactionWrite<Result>): Promise<Result>;
}

export function createInstrumentedStateWriteSql({
    sql,
    metrics,
    timing
}: CreateInstrumentedStateWriteSqlInput): PSqlSql {
    function instrumentedQuery<Result>(
        strings: TemplateStringsArray,
        ...values: readonly PSqlParameter[]
    ): Promise<Result>;
    function instrumentedQuery(values: readonly PSqlParameter[]): object;
    function instrumentedQuery<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!isTemplateStringsArray(stringsOrValues)) {
            return sql(stringsOrValues);
        }
        const queryText = stringsOrValues.join('?');
        const category = classifyBenchmarkSql(queryText, values);
        const startedAt = performance.now();
        return Promise.resolve(sql<Result>(stringsOrValues, ...values)).then(
            (result) => {
                const durationMs = performance.now() - startedAt;
                let serializedResultBytes = 0;
                try {
                    serializedResultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
                }
                catch {
                    // Driver values that cannot serialize must still reach their caller unchanged.
                    serializedResultBytes = 0;
                }
                observeSql({
                    metrics,
                    category,
                    rowsRead: Array.isArray(result) ? result.length : 0,
                    serializedResultBytes,
                    durationMs
                });
                recordRallarTiming({
                    sink: timing,
                    event: {
                        component: 'state-write-benchmark-sql',
                        operation: category,
                        details: { statement: firstSqlKeyword(queryText) }
                    },
                    status: 'ok',
                    durationMs
                });
                return result;
            },
            (error) => {
                const durationMs = performance.now() - startedAt;
                observeSql({ metrics, category, rowsRead: 0, serializedResultBytes: 0, durationMs });
                recordRallarTiming({
                    sink: timing,
                    event: {
                        component: 'state-write-benchmark-sql',
                        operation: category,
                        details: { statement: firstSqlKeyword(queryText) }
                    },
                    status: 'error',
                    durationMs,
                    error: toError(error)
                });
                throw error;
            }
        );
    }
    const instrumented: PSqlSql = Object.assign(instrumentedQuery, {
        begin: async <Result>(write: PSqlTransactionWrite<Result>): Promise<Result> => {
            const startedAt = performance.now();
            let completed = false;
            try {
                const result = await sql.begin(
                    async (transaction) =>
                        await write(createInstrumentedStateWriteSql({ sql: transaction, metrics, timing }))
                );
                completed = true;
                return result;
            }
            finally {
                const durationMs = performance.now() - startedAt;
                metrics.transactionDurationMs += durationMs;
                recordRallarTiming({
                    sink: timing,
                    event: {
                        component: 'state-write-benchmark-phase',
                        operation: 'transaction'
                    },
                    status: completed ? 'ok' : 'error',
                    durationMs
                });
            }
        }
    });
    if (sql.getExecutorCounters) {
        instrumented.getExecutorCounters = sql.getExecutorCounters.bind(sql);
    }
    if (!hasSavepoint(sql)) {
        return instrumented;
    }
    return Object.assign(instrumented, {
        savepoint: async <Result>(write: PSqlTransactionWrite<Result>): Promise<Result> =>
            await sql.savepoint(
                async (transaction) =>
                    await write(createInstrumentedStateWriteSql({ sql: transaction, metrics, timing }))
            )
    });
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

interface ObserveSqlInput {
    readonly metrics: StateWriteSqlMetrics;
    readonly category: 'read' | 'write' | 'outbox';
    readonly rowsRead: number;
    readonly serializedResultBytes: number;
    readonly durationMs: number;
}

function observeSql({ metrics, category, rowsRead, serializedResultBytes, durationMs }: ObserveSqlInput): void {
    metrics.statements += 1;
    metrics.serializedResultBytes += serializedResultBytes;
    if (category === 'read') {
        metrics.rowsRead += rowsRead;
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
    values: readonly PSqlParameter[]
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
    value: TemplateStringsArray | readonly PSqlParameter[]
): value is TemplateStringsArray {
    return Object.hasOwn(value, 'raw');
}

function hasSavepoint(sql: PSqlSql): sql is PSqlSavepointSql {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}
