import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toPhysicalAppInboxQueueKey } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireText, type JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    computeStateWriteDiagnosticPhase,
    type StateWriteDiagnosticPhase
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts';
import { TestResourceInbox } from '../../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxQueueMessageFixture } from '../../rallar-system/app-inbox/test-support/create-app-inbox-queue-message-fixture.ts';

const profile = {
    logicalResourceId: 'PRIVATE:profile-instance:0-profile',
    physicalKey: {
        resourceId: 'PRIVATE:profile-instance:0-profile',
        topicId: 'CLIENT_PRINCIPAL_UPSERT',
        contextId: 'application-PRIVATE-ap-chsq5tya15k6'
    }
};
const instance = {
    logicalResourceId: 'PRIVATE:profile-instance:0-instance',
    physicalKey: {
        resourceId: 'PRIVATE:profile-instance:0-instance',
        topicId: 'CLIENT_INSTANCE_UPSERT',
        contextId: 'application-PRIVATE-ap-chsq5tya15k6'
    }
};
const config = {
    physicalKey: {
        resourceId: 'PRIVATE:config:1',
        topicId: 'GROUP_UPDATE',
        contextId: 'PRIVATE-application-PR-b08hzzfx65w9'
    }
};

const budget = { eventsPerPhase: 100, bytesPerPhase: 32_768, bytesPerRun: 65_536 };

function createPhase(): StateWriteDiagnosticPhase {
    return {
        workload: 'shared',
        phase: 'measured',
        runIndex: 2,
        scope: { applicationId: 'PRIVATE-application', workspaceId: 'PRIVATE-workspace' },
        groupCount: 5,
        serviceIds: ['PRIVATE-worker-a', 'PRIVATE-worker-b'],
        performanceTimeOriginEpochMs: 100_000,
        startedAtMonotonicMs: 10,
        endedAtMonotonicMs: 100,
        commands: [
            { commandId: 'PRIVATE:profile-instance:0', kind: 'profile-instance', stackIndex: 0, status: 'accepted' },
            { commandId: 'PRIVATE:config:1', kind: 'config', stackIndex: 1, status: 'accepted' }
        ],
        boundaries: [
            { commandId: 'PRIVATE:config:1', startedAtMonotonicMs: 40, endedAtMonotonicMs: 90 },
            { commandId: 'PRIVATE:profile-instance:0', startedAtMonotonicMs: 15, endedAtMonotonicMs: 85 }
        ],
        timingEvents: [],
        releases: [],
        outcome: 'completed'
    };
}

function createEvent(requestId: string, details: RallarTimingEvent['details']): RallarTimingEvent {
    return {
        type: 'rallar.timing',
        component: 'app-inbox-phase',
        operation: 'transaction',
        status: 'ok',
        durationMs: 12.34,
        atEpochMs: 99_999,
        serviceId: 'PRIVATE-worker-b',
        requestId,
        details,
        error: { name: 'PRIVATE-error', message: 'PRIVATE-secret' },
        principalId: 'PRIVATE-principal'
    };
}

function readRecords(serialized: string): readonly JsonWireObject[] {
    if (!serialized.trim()) {
        return [];
    }
    return serialized.trim().split('\n').map((line) => {
        const record = decodeJsonWireText(line, 'Diagnostic test record');
        if (record === null || typeof record !== 'object' || Array.isArray(record)) {
            throw new TypeError('Diagnostic test record must be an object');
        }
        return record as JsonWireObject;
    });
}

describe('state-write diagnostic projection', () => {
    it('retains real logical profile, instance and group completions beyond queue key bounds', async () => {
        const phase = createPhase();
        const applicationId = `PRIVATE-${'application'.repeat(20)}`;
        const workspaceId = `PRIVATE-${'workspace'.repeat(20)}`;
        const profileCommandId = `PRIVATE-${'profile'.repeat(25)}:profile-instance:0`;
        const groupCommandId = `PRIVATE-${'group'.repeat(30)}:config:1`;
        const sessionId = `${applicationId}:${workspaceId}:client-0:client-session-0`;
        const clientContextId = `application=${applicationId}:workspace=${workspaceId}:principal=client-0:caller=client-0:session=${
            encodeURIComponent(sessionId)
        }`;
        const enqueues: readonly AppInboxEnqueueInput[] = [
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: `${profileCommandId}-profile`,
                contextId: clientContextId
            },
            {
                type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                resourceId: `${profileCommandId}-instance`,
                contextId: clientContextId
            },
            {
                type: AppInboxType.GROUP_UPDATE,
                topicId: AppInboxType.GROUP_UPDATE,
                resourceId: groupCommandId,
                contextId: `${applicationId}:${workspaceId}:group-1`,
                authority: {
                    descriptor: {
                        operation: 'updateGroup',
                        scope: { applicationId, workspaceId },
                        groupId: 'group-1',
                        targetPrincipalId: null,
                        sessionId: null,
                        request: {
                            requestId: groupCommandId,
                            actorPrincipalId: 'PRIVATE-principal',
                            actorSessionId: 'PRIVATE-session',
                            metadata: { secret: 'PRIVATE-payload' }
                        }
                    }
                }
            }
        ].map((enqueue) => ({ ...enqueue, senderId: 'PRIVATE-principal', data: { secret: 'PRIVATE-payload' } }));
        const events: RallarTimingEvent[] = [];
        const persistedKeys: Key[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: new AppInboxQueueEntryWriter({
                    inboxQueueReader: new InboxQueueReader(new TestResourceInbox(new Map()), {
                        laneBudgetPolicy: 'fixed-retry-two',
                        newLaneConcurrency: 1
                    }, Temporal.Now.instant),
                    newResourceId: () => 'PRIVATE-generated',
                    createMessage: createAppInboxQueueMessageFixture
                }, { serviceId: 'PRIVATE-worker-a', defaultTopicId: 'app-inbox.client-state' }),
                resultWaiter: {
                    waitForResult: async <Result>(
                        _enqueue: AppInboxEnqueueInput,
                        key: Key,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        persistedKeys.push(key);
                        return Either.ofRight(decodeResult({ status: 'stored', detail: 'PRIVATE-payload' }));
                    }
                }
            },
            {
                serviceId: 'PRIVATE-worker-a',
                timing: (event) => events.push(event),
                options: {
                    phaseTiming: false,
                    waitMaxElapsedMsecs: 1_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        const clock = vi.spyOn(performance, 'now')
            .mockReturnValueOnce(20).mockReturnValueOnce(32.34)
            .mockReturnValueOnce(40).mockReturnValueOnce(46.78)
            .mockReturnValueOnce(50).mockReturnValueOnce(55);
        const epoch = vi.spyOn(Date, 'now').mockReturnValue(99_999);
        try {
            for (const enqueue of enqueues) {
                const result = await client.enqueueAndWaitForResult(enqueue, (value) => value);
                expect(result).toEqual(Either.ofRight({ status: 'stored', detail: 'PRIVATE-payload' }));
            }
        }
        finally {
            clock.mockRestore();
            epoch.mockRestore();
        }
        for (const [ordinal, enqueue] of enqueues.entries()) {
            expect(persistedKeys[ordinal]!.resourceId).not.toBe(enqueue.resourceId);
            expect(persistedKeys[ordinal]!.contextId).not.toBe(enqueue.contextId);
        }
        const originalEvents = JSON.stringify(events);
        const logicalPhase: StateWriteDiagnosticPhase = {
            ...phase,
            scope: { applicationId, workspaceId },
            commands: [
                { ...phase.commands[0]!, commandId: profileCommandId },
                { ...phase.commands[1]!, commandId: groupCommandId, stackIndex: 0 }
            ],
            boundaries: [
                { ...phase.boundaries[1]!, commandId: profileCommandId },
                { ...phase.boundaries[0]!, commandId: groupCommandId }
            ],
            timingEvents: events
        };
        const result = computeStateWriteDiagnosticPhase(logicalPhase, budget, 65_536);
        const records = readRecords(result.serialized);
        expect.soft(result.complete).toBe(true);
        expect.soft(records.at(-1)).toMatchObject({
            timing: { total: 3, retained: 3, rejected: 0, truncated: 0, unassociated: 0 }
        });
        expect.soft(records.filter((record) => record.record === 'timing')).toMatchObject([
            {
                component: 'app-inbox',
                operation: 'enqueueAndWaitForResult',
                status: 'ok',
                roundedDurationMs: 12.34,
                association: { commandOrdinal: 0, operation: 'profile', originatingStack: 0, observingStack: 0 }
            },
            {
                component: 'app-inbox',
                operation: 'enqueueAndWaitForResult',
                status: 'ok',
                roundedDurationMs: 6.78,
                association: { commandOrdinal: 0, operation: 'instance', originatingStack: 0, observingStack: 0 }
            },
            {
                component: 'app-inbox',
                operation: 'enqueueAndWaitForResult',
                status: 'ok',
                roundedDurationMs: 5,
                association: { commandOrdinal: 1, operation: 'command', originatingStack: 0, observingStack: 0 }
            }
        ]);
        expect(result.bytes).toBeLessThanOrEqual(32_768);
        expect(JSON.stringify(events)).toBe(originalEvents);
        expect(result.serialized).not.toContain('PRIVATE');

        for (const [ordinal, event] of events.entries()) {
            const enqueue = enqueues[ordinal]!;
            const physicalKey = toPhysicalAppInboxQueueKey({ ...enqueue, resourceId: enqueue.resourceId! });
            const contradictions: readonly RallarTimingEvent[] = [
                { ...event, details: { ...event.details, resourceId: 'PRIVATE-wrong' } },
                { ...event, details: { ...event.details, contextId: 'PRIVATE-wrong' } },
                { ...event, details: { ...event.details, topicId: 'PRIVATE-wrong' } },
                { ...event, details: { ...event.details, type: 'PRIVATE-wrong' } },
                { ...event, serviceId: 'PRIVATE-worker-b' },
                { ...event, details: { ...event.details, resourceId: undefined } },
                { ...event, details: { ...event.details, contextId: undefined } },
                { ...event, details: { ...event.details, topicId: undefined } },
                { ...event, details: { ...event.details, type: undefined } },
                { ...event, serviceId: undefined },
                { ...event, component: 'app-inbox-phase', operation: 'transaction' },
                {
                    ...event,
                    component: 'app-inbox-phase',
                    operation: 'transaction',
                    details: { ...event.details, ...physicalKey, resourceId: enqueue.resourceId }
                },
                { ...event, details: { ...event.details, contextId: physicalKey.contextId } },
                { ...event, details: { ...event.details, resourceId: physicalKey.resourceId } },
                { ...event, details: { ...event.details, ...physicalKey } },
                { ...event, requestId: physicalKey.resourceId, details: { ...event.details, ...physicalKey } }
            ];
            const rejected = computeStateWriteDiagnosticPhase({ ...logicalPhase, timingEvents: contradictions }, budget, 65_536);
            expect.soft(readRecords(rejected.serialized).at(-1)).toMatchObject({
                complete: false,
                timing: { total: 16, retained: 0, rejected: 16, truncated: 0 }
            });
            expect(rejected.serialized).not.toContain('PRIVATE');
        }
        for (
            const ambiguous of [
                { ...logicalPhase, commands: [...logicalPhase.commands, logicalPhase.commands[0]!] },
                { ...logicalPhase, serviceIds: ['PRIVATE-worker-a', 'PRIVATE-worker-a'] }
            ]
        ) {
            const rejected = computeStateWriteDiagnosticPhase({ ...ambiguous, timingEvents: [events[0]!] }, budget, 65_536);
            expect(readRecords(rejected.serialized).at(-1)).toMatchObject({
                complete: false,
                timing: { total: 1, retained: 0, rejected: 1, truncated: 0 }
            });
        }
        const physicalEvents = events.map((event, ordinal) => ({
            ...event,
            component: 'app-inbox-phase',
            operation: 'transaction',
            details: { ...event.details, ...persistedKeys[ordinal]! }
        }));
        const physical = computeStateWriteDiagnosticPhase({ ...logicalPhase, timingEvents: physicalEvents }, budget, 65_536);
        expect(physical.complete).toBe(true);
        expect(readRecords(physical.serialized).at(-1)).toMatchObject({
            timing: { total: 3, retained: 3, rejected: 0, truncated: 0 }
        });
    });

    it('joins interleaved physical and logical operations while separating origin, observer and clocks', () => {
        const phase = createPhase();
        const events = [
            createEvent(instance.logicalResourceId, { ...instance.physicalKey, attempt: 2 }),
            createEvent(config.physicalKey.resourceId, { ...config.physicalKey }),
            createEvent(profile.logicalResourceId, { ...profile.physicalKey, attempt: 1 }),
            {
                ...createEvent(profile.logicalResourceId, { ...profile.physicalKey, attempt: 1 }),
                component: 'app-inbox-handler',
                operation: 'CLIENT_PRINCIPAL_UPSERT'
            }
        ];
        const releases = [instance, profile, config].map((entry) => ({
            key: entry.physicalKey,
            type: 'APP_INBOX',
            resource: 'PRIVATE-payload',
            attempt: entry === instance ? 2 : 1,
            selectedLane: Reservator.NEW,
            queueAgeMs: 40,
            dueAgeMs: 3,
            classification: 'accepted' as const,
            status: EntityStatus.COMPLETED,
            retryDelayMs: 0,
            failure: { kind: 'none' as const }
        }));
        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events, releases }, budget, 65_536);
        const records = readRecords(result.serialized);
        expect(result.complete).toBe(true);
        expect(records.filter((record) => record.record === 'timing').map((record) => record.association)).toEqual([
            { kind: 'command-operation', commandOrdinal: 0, operation: 'instance', originatingStack: 0, observingStack: 1, attempt: 2 },
            { kind: 'command-operation', commandOrdinal: 1, operation: 'command', originatingStack: 1, observingStack: 1, attempt: 'unavailable' },
            { kind: 'command-operation', commandOrdinal: 0, operation: 'profile', originatingStack: 0, observingStack: 1, attempt: 1 },
            { kind: 'command-operation', commandOrdinal: 0, operation: 'profile', originatingStack: 0, observingStack: 1, attempt: 1 }
        ]);
        expect(records.find((record) => record.record === 'timing')).toMatchObject({
            completedAtEpochMs: 99_999,
            roundedDurationMs: 12.34,
            approximateStartedAtEpochMs: 99_986.66
        });
        expect(records.find((record) => record.record === 'phase')).toMatchObject({
            startedAtMonotonicMs: 10,
            endedAtMonotonicMs: 100,
            nativeProfilerAlignment: 'unavailable'
        });
        expect(records.find((record) => record.record === 'kind')).toMatchObject({
            kind: 'profile-instance',
            startMs: 15,
            endMs: 85,
            clock: 'derived-command-envelope'
        });
        expect(records.filter((record) => record.record === 'release')).toEqual([
            {
                record: 'release',
                commandOrdinal: 0,
                operation: 'instance',
                originatingStack: 0,
                observingStack: 'unavailable',
                endpoint: 'unavailable',
                attempt: 2,
                classification: 'accepted',
                status: 'COMPLETED',
                selectedLane: 'NEW',
                queueAgeMs: 40,
                dueAgeMs: 3,
                retryDelayMs: 0,
                failure: 'none'
            },
            {
                record: 'release',
                commandOrdinal: 0,
                operation: 'profile',
                originatingStack: 0,
                observingStack: 'unavailable',
                endpoint: 'unavailable',
                attempt: 1,
                classification: 'accepted',
                status: 'COMPLETED',
                selectedLane: 'NEW',
                queueAgeMs: 40,
                dueAgeMs: 3,
                retryDelayMs: 0,
                failure: 'none'
            },
            {
                record: 'release',
                commandOrdinal: 1,
                operation: 'command',
                originatingStack: 1,
                observingStack: 'unavailable',
                endpoint: 'unavailable',
                attempt: 1,
                classification: 'accepted',
                status: 'COMPLETED',
                selectedLane: 'NEW',
                queueAgeMs: 40,
                dueAgeMs: 3,
                retryDelayMs: 0,
                failure: 'none'
            }
        ]);
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it.each(['app-inbox-phase', 'app-inbox'])('rejects mismatched and ambiguous %s identities and unsupported labels', (component) => {
        const phase = createPhase();
        const event = {
            ...createEvent(profile.logicalResourceId, { ...profile.physicalKey, contextId: 'PRIVATE-wrong' }),
            component,
            serviceId: 'PRIVATE-worker-a',
            operation: component === 'app-inbox' ? 'enqueueAndWaitForResult' : 'transaction'
        };
        const events = [
            event,
            { ...event, requestId: 'PRIVATE-unknown', details: {} },
            {
                ...event,
                operation: 'PRIVATE-SQL-payload'
            },
            { ...event, component: 'constructor', details: {} },
            { ...event, component: 'toString', details: {} }
        ];
        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, budget, 65_536);
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { total: 5, retained: 0, rejected: 5, truncated: 0 } });
        expect(result.serialized).not.toContain('PRIVATE');
        const duplicate = { ...phase, commands: [...phase.commands, phase.commands[0]], timingEvents: [{ ...event, details: {} }] };
        const ambiguousRequest = computeStateWriteDiagnosticPhase(duplicate, budget, 65_536);
        expect(ambiguousRequest.complete).toBe(false);
        expect(readRecords(ambiguousRequest.serialized).at(-1)).toMatchObject({ timing: { total: 1, rejected: 1, retained: 0 } });
    });

    it.each([
        { component: 'app-inbox-phase', retained: 2, rejected: 3 },
        { component: 'app-inbox', retained: 0, rejected: 5 }
    ])('marks missing required $component origin identity and contradictions incomplete', ({ component, retained, rejected }) => {
        const phase = createPhase();
        const event = {
            ...createEvent(profile.logicalResourceId, {}),
            component,
            serviceId: 'PRIVATE-worker-a',
            operation: component === 'app-inbox' ? 'enqueueAndWaitForResult' : 'transaction'
        };
        const missing = { ...event, requestId: undefined };
        const contradictory = {
            ...createEvent(profile.physicalKey.resourceId, { ...profile.physicalKey }),
            component: 'app-inbox-handler',
            operation: 'GROUP_UPDATE'
        };
        const result = computeStateWriteDiagnosticPhase(
            {
                ...phase,
                timingEvents: [
                    missing,
                    contradictory,
                    { ...event, details: { ...instance.physicalKey } },
                    { ...event, serviceId: undefined },
                    { ...event, serviceId: 'PRIVATE-worker-b' }
                ]
            },
            budget,
            65_536
        );
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { total: 5, rejected, retained } });
        const ambiguousWorker = computeStateWriteDiagnosticPhase(
            { ...phase, serviceIds: ['PRIVATE-worker-a', 'PRIVATE-worker-a'], timingEvents: [event] },
            budget,
            65_536
        );
        expect(ambiguousWorker.complete).toBe(false);
        expect(readRecords(ambiguousWorker.serialized).at(-1)).toMatchObject({ timing: { total: 1, rejected: 1, retained: 0 } });
    });

    it('keeps SQL process-level and discloses that begin status is not commit evidence', () => {
        const phase = createPhase();
        const event: RallarTimingEvent = {
            type: 'rallar.timing',
            component: 'state-write-benchmark-phase',
            operation: 'transaction',
            status: 'ok',
            durationMs: 2,
            atEpochMs: 101_000
        };
        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: [event] }, budget, 65_536);
        expect(readRecords(result.serialized).find((record) => record.record === 'timing')).toMatchObject({
            association: { kind: 'process-unassociated', reason: 'sql-process-scope' },
            statusMeaning: 'wrapper-finally-not-commit'
        });
        expect(result.complete).toBe(true);
    });

    it('shares the event ceiling between releases and timing records, retaining release facts first', () => {
        const phase = createPhase();
        const release = {
            key: profile.physicalKey,
            type: 'APP_INBOX',
            resource: 'PRIVATE',
            attempt: 1,
            selectedLane: Reservator.NEW,
            queueAgeMs: 1,
            dueAgeMs: 0,
            classification: 'accepted' as const,
            status: EntityStatus.COMPLETED,
            retryDelayMs: 0,
            failure: { kind: 'none' as const }
        };
        const result = computeStateWriteDiagnosticPhase(
            { ...phase, releases: [release], timingEvents: [createEvent(profile.logicalResourceId, {}), createEvent(profile.logicalResourceId, {})] },
            { ...budget, eventsPerPhase: 2 },
            65_536
        );
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ releases: { total: 1, retained: 1 }, timing: { total: 2, retained: 1, truncated: 1 } });
    });

    it('bounds records and serialized bytes while preserving inputs and prioritizing boundaries', () => {
        const phase = createPhase();
        const events = Array.from({ length: 20 }, () => createEvent(profile.logicalResourceId, {}));
        const snapshot = JSON.stringify(events);
        const capped = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, { ...budget, eventsPerPhase: 2 }, 65_536);
        expect(capped.complete).toBe(false);
        expect(readRecords(capped.serialized).at(-1)).toMatchObject({ timing: { total: 20, retained: 2, truncated: 18 } });
        const byteCapped = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, { ...budget, bytesPerPhase: 2_048 }, 65_536);
        expect(byteCapped.bytes).toBeLessThanOrEqual(2_048);
        expect(byteCapped.complete).toBe(false);
        const runCapped = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, budget, 1_024);
        expect(runCapped.bytes).toBeLessThanOrEqual(1_024);
        expect(runCapped.complete).toBe(false);
        expect(JSON.stringify(events)).toBe(snapshot);
        expect(readRecords(capped.serialized).filter((record) => record.record === 'command')).toHaveLength(2);
    });
});
