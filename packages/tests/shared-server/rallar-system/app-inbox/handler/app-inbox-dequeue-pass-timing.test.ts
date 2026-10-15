import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlExecutorCounters } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxDequeuePassTiming } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-dequeue-pass-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createAppInboxQueueMessageFixture } from '../test-support/create-app-inbox-queue-message-fixture.ts';

interface SimulatedExecutor {
    readonly counters: { statements: number; executorWaitMs: number; };
    nowMs: number;
    readonly timing: RallarTimingEvent[];
    readonly observer: AppInboxDequeuePassTiming;
    /** The executor ran this many statements, each waiting one millisecond, while the clock advanced the same amount. */
    run(statements: number): void;
}

describe('AppInboxDequeuePassTiming', () => {
    it('reports, per claimed item, the pass cost outside the handlers together with the lanes the probe advertised', () => {
        const executor = createSimulatedExecutor();
        const first = createAttempt('first', Reservator.NEW);
        const second = createAttempt('second', Reservator.RETRY);

        executor.observer.onProbeStarted();
        executor.run(1);
        executor.observer.onProbeFinished({ FINALIZATION: false, NEW: true, RETRY: true, FAIRNESS: true, TIMEOUT: false });
        executor.run(5);
        executor.observer.onPassStarted();
        executor.run(1);
        executor.observer.onHandlerStarted(first);
        executor.run(3);
        executor.observer.onHandlerFinished(first);
        executor.run(1);
        executor.observer.onHandlerStarted(second);
        executor.run(2);
        executor.observer.onHandlerFinished(second);
        executor.run(1);
        executor.observer.onPassFinished();

        expect(executor.timing).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass',
                serviceId: 'server-1',
                requestId: 'first',
                status: 'ok',
                durationMs: 4,
                details: {
                    type: AppInboxType.GROUP_CREATE,
                    topicId: 'app-inbox.group-state',
                    contextId: 'group-1',
                    resourceId: 'first',
                    senderId: undefined,
                    attempt: 1,
                    selectedLane: 'NEW',
                    queueAgeMs: 5,
                    dueAgeMs: 0,
                    statements: 4,
                    executorWaitMs: 4,
                    lanesProbed: 'NEW,RETRY,FAIRNESS',
                    claimedInPass: 2
                }
            }),
            expect.objectContaining({ requestId: 'second', durationMs: 4, details: expect.objectContaining({ selectedLane: 'RETRY', statements: 4 }) })
        ]);
    });

    it('reports a pass that no probe preceded with no probed lanes and leaves an unclaimed probe behind', () => {
        const executor = createSimulatedExecutor();
        executor.observer.onProbeStarted();
        executor.run(1);
        executor.observer.onProbeFinished({ FINALIZATION: false, NEW: false, RETRY: false, FAIRNESS: false, TIMEOUT: false });
        const only = createAttempt('only', Reservator.TIMEOUT);

        executor.observer.onPassStarted();
        executor.run(2);
        executor.observer.onHandlerStarted(only);
        executor.run(1);
        executor.observer.onHandlerFinished(only);
        executor.observer.onPassFinished();

        expect(executor.timing).toEqual([
            expect.objectContaining({
                requestId: 'only',
                durationMs: 3,
                details: expect.objectContaining({ statements: 3, lanesProbed: '', claimedInPass: 1 })
            })
        ]);
    });

    it('reports nothing for a pass that claimed nothing', () => {
        const executor = createSimulatedExecutor();

        executor.observer.onPassStarted();
        executor.run(2);
        executor.observer.onPassFinished();

        expect(executor.timing).toEqual([]);
    });
});

function createSimulatedExecutor(): SimulatedExecutor {
    const counters = { statements: 0, executorWaitMs: 0 };
    const timing: RallarTimingEvent[] = [];
    const executor: SimulatedExecutor = {
        counters,
        nowMs: 1_000,
        timing,
        observer: new AppInboxDequeuePassTiming(
            {
                database: { getExecutorCounters: (): PSqlExecutorCounters => ({ ...counters }) },
                nowMs: () => executor.nowMs
            },
            { serviceId: 'server-1', sink: (event) => timing.push(event) }
        ),
        run: (statements) => {
            counters.statements += statements;
            counters.executorWaitMs += statements;
            executor.nowMs += statements;
        }
    };
    return executor;
}

function createAttempt(resourceId: string, selectedLane: Reservator): ResourceInboxAttempt {
    const key = { topicId: 'app-inbox.group-state', resourceId, contextId: 'group-1' };
    const enqueue = { type: AppInboxType.GROUP_CREATE, resourceId, contextId: 'group-1', data: null } as const;
    const createdTs = Temporal.PlainDateTime.from('2026-07-22T12:00:00');
    const entry: ResourceEntry = {
        key,
        resource: JSON.stringify(createAppInboxQueueMessageFixture({ key, enqueue, serviceId: 'server-1' })),
        typeId: 'APP_INBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'server-1',
            createdTs,
            expiryTs: Temporal.Instant.from('2026-07-22T13:00:00Z')
        },
        dequeueAudit: { attempts: 1, startTs: Temporal.Instant.from('2026-07-22T12:00:00Z') }
    };
    return {
        entry,
        telemetry: { selectedLane, queueAgeMs: 5, dueAgeMs: 0, attempt: 1, selectedDueAtEpochMs: 995, reservationLeaseMs: 60_000 }
    };
}
