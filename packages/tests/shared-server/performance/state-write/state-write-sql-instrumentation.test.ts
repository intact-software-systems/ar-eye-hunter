import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPSqlCounterScope } from '@shared-server/postgres/create-p-sql-counter-scope.ts';
import type { PSqlExecutorCounters, PSqlParameter, PSqlSql, PSqlTransactionWrite } from '@shared-server/postgres/p-sql-sql.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createInstrumentedStateWriteSql,
    type StateWriteSqlMetrics
} from '../../../../../apps/api-v1/scripts/perf/create-instrumented-state-write-sql.ts';
import { createAtomicHarness } from '../../rallar-system/app-inbox/test-support/app-inbox-transaction-test-runtime.ts';

afterEach(() => vi.restoreAllMocks());

describe('state-write SQL instrumentation', () => {
    it.each([false, true])('retains native AppInbox transaction counters and atomic completion (result write fails: %s)', async (failResultWrite) => {
        const harness = createAtomicHarness({ failResultWrite });
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const begin = harness.database.sql.begin.bind(harness.database.sql);
        harness.database.sql.begin = async <Result>(write: PSqlTransactionWrite<Result>): Promise<Result> => {
            now += 7;
            try {
                return await begin(write);
            }
            finally {
                now += 11;
            }
        };
        const events: RallarTimingEvent[] = [];
        const metrics = createMetrics();
        const sql = createInstrumentedStateWriteSql({
            sql: createPSqlCounterScope(harness.database.sql, { timesBeginWait: false }),
            metrics,
            timing: (event) => events.push(event)
        });
        const writer = new AppInboxTransactionWriter(
            { database: sql, nowEpochMs: () => harness.context.attemptTelemetry.selectedAtEpochMs },
            { serviceId: 'server-1', timing: (event) => events.push(event) }
        );
        const completionInput = {
            ...writer.readCompletionFacts(harness.context),
            status: EntityStatus.COMPLETED,
            durableResult: { accepted: true }
        } as const;
        const completion = computeAppInboxCompletion(completionInput);
        expect(validateAppInboxCompletion(completionInput, completion)).toEqual([]);

        const result = writer.writeComputedMutation(harness.context, completion, async () => {
            now += 13;
        });

        if (failResultWrite) {
            await expect(result).rejects.toThrow('result write failed');
        }
        else {
            await expect(result).resolves.toEqual({ accepted: true });
        }
        expect(harness.database.state.results.size).toBe(failResultWrite ? 0 : 1);
        expect(events.find((event) => event.component === 'app-inbox-phase')).toMatchObject({
            operation: 'transaction',
            status: failResultWrite ? 'error' : 'ok',
            durationMs: 31,
            details: { statements: 2, executorWaitMs: 0, beginWaitMs: 7 }
        });
        expect(events.find((event) => event.component === 'state-write-benchmark-phase')).toMatchObject({
            operation: 'transaction',
            status: failResultWrite ? 'error' : 'ok',
            durationMs: 31
        });
        expect(metrics).toMatchObject({ statements: 2, transactionDurationMs: 31 });
    });

    it('preserves the receiver and the counters of each root, transaction and savepoint handle', async () => {
        const sql = createInstrumentedStateWriteSql({ sql: createCounterSql(1), metrics: createMetrics(), timing: () => {} });

        expect(sql.getExecutorCounters?.()).toEqual({ statements: 1, executorWaitMs: 2 });
        const nested = await sql.begin(async (transaction) => {
            expect(transaction.getExecutorCounters?.()).toEqual({ statements: 2, executorWaitMs: 4 });
            if (!hasSavepoint(transaction)) {
                throw new Error('Instrumented transaction lost its savepoint capability');
            }
            return await transaction.savepoint(async (savepoint) => savepoint.getExecutorCounters?.());
        });

        expect(nested).toEqual({ statements: 3, executorWaitMs: 6 });
    });

    it('keeps an uncounted port uncounted, including its transaction handle', async () => {
        const harness = createAtomicHarness();
        const sql = createInstrumentedStateWriteSql({ sql: harness.database.sql, metrics: createMetrics(), timing: () => {} });

        expect(sql.getExecutorCounters).toBeUndefined();
        await sql.begin(async (transaction) => expect(transaction.getExecutorCounters).toBeUndefined());
    });

    it('records a rejected begin as an error without inventing callback-entry wait or changing the rejection', async () => {
        const harness = createAtomicHarness();
        const failure = new Error('connection unavailable');
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        harness.database.sql.begin = async () => {
            now += 17;
            throw failure;
        };
        const events: RallarTimingEvent[] = [];
        const metrics = createMetrics();
        const sql = createInstrumentedStateWriteSql({
            sql: createPSqlCounterScope(harness.database.sql, { timesBeginWait: true }),
            metrics,
            timing: (event) => events.push(event)
        });

        await expect(sql.begin(async () => {
            throw new Error('Begin must not enter its callback');
        })).rejects.toBe(failure);

        expect(events).toMatchObject([{ component: 'state-write-benchmark-phase', operation: 'transaction', status: 'error', durationMs: 17 }]);
        expect(metrics.transactionDurationMs).toBe(17);
        // Native begin wait advances only on callback entry; zero here does not mean acquisition was immediate.
        expect(sql.getExecutorCounters?.()).toEqual({ statements: 0, executorWaitMs: 0, beginWaitMs: 0 });
    });
});

function createMetrics(): StateWriteSqlMetrics {
    return { statements: 0, rowsRead: 0, serializedResultBytes: 0, readMs: 0, writeMs: 0, outboxSqlMs: 0, transactionDurationMs: 0 };
}

interface CounterSql extends PSqlSql {
    readonly snapshot: PSqlExecutorCounters;
    savepoint<Result>(write: PSqlTransactionWrite<Result>): Promise<Result>;
}

/** Native handles may own different counters and require their receiver when exposing a snapshot. */
function createCounterSql(statements: number): CounterSql {
    function sql<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function sql(values: readonly PSqlParameter[]): object;
    function sql(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[]): object {
        if ('raw' in stringsOrValues) {
            throw new Error('Counter capability fixture does not execute statements');
        }
        return { values: stringsOrValues };
    }
    return Object.assign(sql, {
        snapshot: { statements, executorWaitMs: statements * 2 },
        getExecutorCounters(this: CounterSql): PSqlExecutorCounters {
            return this.snapshot;
        },
        async begin<Result>(this: CounterSql, write: PSqlTransactionWrite<Result>): Promise<Result> {
            return await write(createCounterSql(this.snapshot.statements + 1));
        },
        async savepoint<Result>(this: CounterSql, write: PSqlTransactionWrite<Result>): Promise<Result> {
            return await write(createCounterSql(this.snapshot.statements + 1));
        }
    });
}

function hasSavepoint(sql: PSqlSql): sql is PSqlSql & Pick<CounterSql, 'savepoint'> {
    return 'savepoint' in sql && typeof sql.savepoint === 'function';
}
