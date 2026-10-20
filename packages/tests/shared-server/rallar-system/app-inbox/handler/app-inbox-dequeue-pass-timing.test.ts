import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlExecutorCounters } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxDequeuePassTiming } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-dequeue-pass-timing.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
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
    getLines(operation: 'dequeue-pass' | 'dequeue-pass-boundary'): RallarTimingEvent[];
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

        expect(executor.getLines('dequeue-pass')).toEqual([
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
                    claimedInPass: 2,
                    passWallMs: 8,
                    handlersMs: 5
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

        expect(executor.getLines('dequeue-pass')).toEqual([
            expect.objectContaining({
                requestId: 'only',
                durationMs: 3,
                details: expect.objectContaining({
                    statements: 3,
                    lanesProbed: '',
                    claimedInPass: 1,
                    passWallMs: 3,
                    handlersMs: 1
                })
            })
        ]);
    });

    it('reports an outbox pass with the claimed queued message type', () => {
        const executor = createSimulatedExecutor();
        const presenceSummary = createOutboxAttempt('presence-summary', 'GROUP_PRESENCE_SUMMARY');

        executor.observer.onProbeStarted();
        executor.run(1);
        executor.observer.onProbeFinished({ FINALIZATION: false, NEW: true, RETRY: false, FAIRNESS: false, TIMEOUT: false });
        executor.observer.onPassStarted();
        executor.run(1);
        executor.observer.onHandlerStarted(presenceSummary);
        executor.run(2);
        executor.observer.onHandlerFinished(presenceSummary);
        executor.observer.onPassFinished();

        expect(executor.getLines('dequeue-pass')).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass',
                requestId: 'presence-summary',
                durationMs: 2,
                details: {
                    type: 'GROUP_PRESENCE_SUMMARY',
                    topicId: 'app-outbox.presence',
                    contextId: 'group-1',
                    resourceId: 'presence-summary',
                    senderId: undefined,
                    attempt: 1,
                    selectedLane: 'NEW',
                    queueAgeMs: 5,
                    dueAgeMs: 0,
                    statements: 2,
                    executorWaitMs: 2,
                    lanesProbed: 'NEW',
                    claimedInPass: 1,
                    passWallMs: 3,
                    handlersMs: 2
                }
            })
        ]);
    });

    // The pass once subtracted the sum of concurrent handler spans, so concurrent heads reported a negative cost.
    it('attributes concurrent handlers by the union of their spans, so the pass cost outside them is never negative', () => {
        const executor = createSimulatedExecutor();
        const first = createAttempt('first', Reservator.NEW);
        const second = createAttempt('second', Reservator.NEW);

        executor.observer.onPassStarted();
        executor.run(1);
        executor.observer.onHandlerStarted(first);
        executor.run(2);
        executor.observer.onHandlerStarted(second);
        executor.run(3);
        executor.observer.onHandlerFinished(first);
        executor.run(1);
        executor.observer.onHandlerFinished(second);
        executor.run(1);
        executor.observer.onPassFinished();

        expect(executor.getLines('dequeue-pass').map(({ requestId, durationMs, details }) => ({ requestId, durationMs, details }))).toEqual(
            ['first', 'second'].map((requestId) => ({
                requestId,
                durationMs: 2,
                details: expect.objectContaining({ statements: 2, executorWaitMs: 2, passWallMs: 8, handlersMs: 6 })
            }))
        );
    });

    it('closes a claiming pass with one boundary line: its wall, the probe before it and what it claimed per lane', () => {
        const executor = createSimulatedExecutor();
        const first = createAttempt('first', Reservator.NEW);
        const second = createAttempt('second', Reservator.NEW);
        const retry = createAttempt('retry', Reservator.RETRY);

        executor.observer.onProbeStarted();
        executor.run(1);
        executor.observer.onProbeFinished({ FINALIZATION: false, NEW: true, RETRY: true, FAIRNESS: false, TIMEOUT: false });
        executor.nowMs += 5;
        executor.observer.onPassStarted();
        for (const attempt of [first, second, retry]) {
            executor.observer.onHandlerStarted(attempt);
            executor.run(2);
            executor.observer.onHandlerFinished(attempt);
        }
        executor.observer.onPassFinished();

        expect(executor.getLines('dequeue-pass')).toHaveLength(3);
        expect(executor.getLines('dequeue-pass-boundary')).toEqual([
            expect.objectContaining({
                component: 'app-inbox-phase',
                operation: 'dequeue-pass-boundary',
                serviceId: 'server-1',
                status: 'ok',
                durationMs: 6,
                details: {
                    passWallMs: 6,
                    lanesProbed: 'NEW,RETRY',
                    probeMs: 1,
                    probeToPassMs: 5,
                    claimedInPass: 3,
                    claimedNew: 2,
                    claimedRetry: 1,
                    claimedFairness: 0,
                    claimedTimeout: 0,
                    claimedFinalization: 0
                }
            })
        ]);
    });

    it('closes a pass that claimed nothing with its boundary line alone', () => {
        const executor = createSimulatedExecutor();

        executor.observer.onPassStarted();
        executor.run(2);
        executor.observer.onPassFinished();

        expect(executor.timing).toEqual([
            expect.objectContaining({
                operation: 'dequeue-pass-boundary',
                durationMs: 2,
                details: {
                    passWallMs: 2,
                    lanesProbed: '',
                    probeMs: undefined,
                    probeToPassMs: undefined,
                    claimedInPass: 0,
                    claimedNew: 0,
                    claimedRetry: 0,
                    claimedFairness: 0,
                    claimedTimeout: 0,
                    claimedFinalization: 0
                }
            })
        ]);
    });

    it('reports nothing for a pass it never saw start', () => {
        const executor = createSimulatedExecutor();

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
        },
        getLines: (operation) => timing.filter((event) => event.operation === operation)
    };
    return executor;
}

function createOutboxAttempt(resourceId: string, messageTypeId: string): ResourceInboxAttempt {
    const key = { topicId: 'app-outbox.presence', resourceId, contextId: 'group-1' };
    const createdTs = Temporal.PlainDateTime.from('2026-07-22T12:00:00');
    const entry: ResourceEntry = {
        key,
        resource: JSON.stringify(newALUntargetedMessage('api-v1', newALRoute(key.topicId, key.contextId, resourceId), messageTypeId, {})),
        typeId: 'APP_OUTBOX',
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
        telemetry: {
            selectedLane: Reservator.NEW,
            queueAgeMs: 5,
            dueAgeMs: 0,
            attempt: 1,
            selectedDueAtEpochMs: 995,
            reservationLeaseMs: 60_000,
            selectedAtEpochMs: 1_000
        }
    };
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
        telemetry: { selectedLane, queueAgeMs: 5, dueAgeMs: 0, attempt: 1, selectedDueAtEpochMs: 995, reservationLeaseMs: 60_000, selectedAtEpochMs: 1_000 }
    };
}
