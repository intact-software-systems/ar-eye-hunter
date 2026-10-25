import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PSqlExecutorCounters, PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { AppInboxHandlerExecutor } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-executor.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { createAtomicHarness } from '../test-support/app-inbox-transaction-test-runtime.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../test-support/test-app-inbox-finished-retention.ts';

interface CountingDatabase {
    readonly sql: PSqlSql;
    readonly counters: { statements: number; executorWaitMs: number; };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('AppInbox phase timing executor counters', () => {
    it('reports the executor statement and wait deltas of the transaction and of the handler action', async () => {
        const harness = createAtomicHarness();
        const database = createCountingDatabase();
        const timing: RallarTimingEvent[] = [];
        const writer = new AppInboxTransactionWriter(
            { database: database.sql, nowEpochMs: () => 1_000 },
            { finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS, serviceId: 'server-1', timing: (event) => timing.push(event) }
        );
        const executor = new AppInboxHandlerExecutor(
            {
                resultRepository: { replace: async (entry) => entry, findByKey: async () => undefined },
                transactionWriter: writer,
                database: database.sql,
                nowEpochMs: () => 1_000,
                dequeueNowEpochMs: () => harness.context.attemptTelemetry.selectedAtEpochMs,
                timers: createDefaultTimers()
            },
            { serviceId: 'server-1', timing: (event) => timing.push(event), options: { phaseTiming: true } }
        );
        await database.sql`select 'before the handler'`;

        await executor.execute<JsonWireValue, JsonWireValue>({
            registration: {
                type: AppInboxType.GROUP_CREATE,
                decodeCommand: (value) => value,
                encodeResult: (result) => result,
                handle: async (_command, context) => {
                    await database.sql`select 'handler read'`;
                    return await commit(writer, context, { accepted: true });
                }
            },
            message: harness.context.message,
            entry: harness.entry,
            attemptTelemetry: harness.context.attemptTelemetry
        });

        const transaction = timing.find((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction');
        const handlerAction = timing.find((event) => event.component === 'app-inbox-phase' && event.operation === 'handler-action');
        expect(transaction?.details).toMatchObject({
            resourceId: harness.entry.key.resourceId,
            selectedLane: harness.context.attemptTelemetry.selectedLane,
            attempt: harness.entry.dequeueAudit.attempts,
            statements: 2,
            executorWaitMs: expect.any(Number),
            beginWaitMs: expect.any(Number)
        });
        expect(handlerAction?.details).toMatchObject({ resourceId: harness.entry.key.resourceId, statements: 3, executorWaitMs: 3 });
        expect(handlerAction?.details).not.toHaveProperty('beginWaitMs');
        expect(database.counters.statements).toBe(4);
    });

    it('credits the transaction line only its own statements while the executor counts every statement', async () => {
        const harness = createAtomicHarness();
        const database = createCountingDatabase();
        const timing: RallarTimingEvent[] = [];
        const writer = new AppInboxTransactionWriter(
            { database: database.sql, nowEpochMs: () => 1_000 },
            { finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS, serviceId: 'server-1', timing: (event) => timing.push(event) }
        );
        const completionInput = { ...writer.readCompletionFacts(harness.context), status: EntityStatus.COMPLETED, durableResult: { accepted: true } } as const;
        const completion = computeAppInboxCompletion(completionInput);

        await writer.writeComputedMutation(harness.context, completion, async () => {
            await database.sql`select 'a concurrent route statement on the shared executor'`;
        });

        const transaction = timing.find((event) => event.operation === 'transaction');
        expect(transaction?.details).toMatchObject({ statements: 2, executorWaitMs: expect.any(Number) });
        expect(database.counters).toEqual({ statements: 3, executorWaitMs: 3 });
    });

    it('reads no clock around the transaction begin when timing is off, only the per-statement waits', async () => {
        const harness = createAtomicHarness();
        const database = createCountingDatabase();
        const writer = new AppInboxTransactionWriter(
            { database: database.sql, nowEpochMs: () => 1_000 },
            { finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS, serviceId: 'server-1', timing: undefined }
        );
        const clockReads = vi.spyOn(performance, 'now');

        await commit(writer, harness.context, { accepted: true });

        // Each statement of the transaction reads the clock at its call and at its completion; its begin reads none.
        expect(database.counters.statements).toBe(2);
        expect(clockReads).toHaveBeenCalledTimes(2 * database.counters.statements);
    });

    it('keeps the phase lines without counters when the port does not count', async () => {
        const harness = createAtomicHarness();
        const database = createCountingDatabase();
        const uncounted = Object.assign(
            (...input: Parameters<PSqlSql>) => (database.sql as (...input: Parameters<PSqlSql>) => object)(...input),
            { begin: database.sql.begin }
        ) as PSqlSql;
        const timing: RallarTimingEvent[] = [];
        const writer = new AppInboxTransactionWriter(
            { database: uncounted, nowEpochMs: () => 1_000 },
            { finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS, serviceId: 'server-1', timing: (event) => timing.push(event) }
        );

        await commit(writer, harness.context, { accepted: true });

        const transaction = timing.find((event) => event.operation === 'transaction');
        expect(transaction?.details).toMatchObject({ resourceId: harness.entry.key.resourceId });
        expect(transaction?.details).not.toHaveProperty('statements');
        expect(transaction?.details).not.toHaveProperty('beginWaitMs');
    });
});

async function commit(
    writer: AppInboxTransactionWriter,
    context: AppInboxMessageContext<JsonWireValue>,
    durableResult: JsonWireValue
): Promise<JsonWireValue> {
    const completionInput = { ...writer.readCompletionFacts(context), status: EntityStatus.COMPLETED, durableResult } as const;
    const completion = computeAppInboxCompletion(completionInput);
    expect(validateAppInboxCompletion(completionInput, completion)).toEqual([]);
    return await writer.writeComputedMutation(context, completion, async () => {});
}

/** Every template statement counts one and waits one millisecond; transaction statements count on the same executor. */
function createCountingDatabase(): CountingDatabase {
    const counters = { statements: 0, executorWaitMs: 0 };
    function sql(stringsOrValues: TemplateStringsArray | readonly PSqlParameter[], ..._values: readonly PSqlParameter[]): object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return {};
        }
        counters.statements += 1;
        counters.executorWaitMs += 1;
        return Promise.resolve([{ ri_row_id: 1n }]);
    }
    const database = Object.assign(sql, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => await write(database),
        getExecutorCounters: (): PSqlExecutorCounters => ({ ...counters })
    }) as PSqlSql;
    return { sql: database, counters };
}
