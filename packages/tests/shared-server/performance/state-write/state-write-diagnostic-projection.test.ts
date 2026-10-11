import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireText, type JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    computeStateWriteDiagnosticPhase,
    type StateWriteDiagnosticPhase
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts';

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
    it('retains real originating profile and instance AppInbox completions with phase timing disabled', async () => {
        const events: RallarTimingEvent[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    enqueue: async (enqueue) => toAppInboxResourceEntry(enqueue, 'PRIVATE-worker-b'),
                    enqueueReplacingTerminal: async (enqueue) => toAppInboxResourceEntry(enqueue, 'PRIVATE-worker-b').key
                },
                resultWaiter: {
                    waitForResult: async <Result>(
                        _enqueue: AppInboxEnqueueInput,
                        _key: Key,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => Either.ofRight(decodeResult({ status: 'stored', detail: 'PRIVATE-payload' }))
                }
            },
            {
                serviceId: 'PRIVATE-worker-b',
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
            .mockReturnValueOnce(40).mockReturnValueOnce(46.78);
        const epoch = vi.spyOn(Date, 'now').mockReturnValue(99_999);
        try {
            const profileResult = await client.enqueueAndWaitForResult({
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                ...profile.physicalKey,
                senderId: 'PRIVATE-principal',
                data: { secret: 'PRIVATE-profile-payload' }
            }, (value) => value);
            const instanceResult = await client.enqueueAndWaitForResult({
                type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                ...instance.physicalKey,
                senderId: 'PRIVATE-principal',
                data: { secret: 'PRIVATE-instance-payload' }
            }, (value) => value);
            expect(profileResult).toEqual(Either.ofRight({ status: 'stored', detail: 'PRIVATE-payload' }));
            expect(instanceResult).toEqual(Either.ofRight({ status: 'stored', detail: 'PRIVATE-payload' }));
        }
        finally {
            clock.mockRestore();
            epoch.mockRestore();
        }

        const originalEvents = JSON.stringify(events);
        const result = computeStateWriteDiagnosticPhase({ ...createPhase(), timingEvents: events }, budget, 65_536);
        const records = readRecords(result.serialized);
        expect.soft(result.complete).toBe(true);
        expect.soft(records.at(-1)).toMatchObject({
            timing: { total: 2, retained: 2, rejected: 0, truncated: 0, unassociated: 0 }
        });
        expect(records.filter((record) => record.record === 'timing')).toEqual([
            {
                record: 'timing',
                component: 'app-inbox',
                operation: 'enqueueAndWaitForResult',
                status: 'ok',
                completedAtEpochMs: 99_999,
                roundedDurationMs: 12.34,
                approximateStartedAtEpochMs: 99_986.66,
                association: {
                    kind: 'command-operation',
                    commandOrdinal: 0,
                    operation: 'profile',
                    originatingStack: 0,
                    observingStack: 1,
                    attempt: 'unavailable'
                },
                queueAgeMs: 'unavailable',
                dueAgeMs: 'unavailable',
                statusMeaning: 'timed-operation-status'
            },
            {
                record: 'timing',
                component: 'app-inbox',
                operation: 'enqueueAndWaitForResult',
                status: 'ok',
                completedAtEpochMs: 99_999,
                roundedDurationMs: 6.78,
                approximateStartedAtEpochMs: 99_992.22,
                association: {
                    kind: 'command-operation',
                    commandOrdinal: 0,
                    operation: 'instance',
                    originatingStack: 0,
                    observingStack: 1,
                    attempt: 'unavailable'
                },
                queueAgeMs: 'unavailable',
                dueAgeMs: 'unavailable',
                statusMeaning: 'timed-operation-status'
            }
        ]);
        expect(result.bytes).toBeLessThanOrEqual(32_768);
        expect(JSON.stringify(events)).toBe(originalEvents);
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it('joins interleaved physical and logical operations while separating origin, observer and clocks', () => {
        const phase = createPhase();
        const events = [
            createEvent(instance.logicalResourceId, { ...instance.physicalKey, attempt: 2 }),
            createEvent(config.physicalKey.resourceId, { ...config.physicalKey }),
            createEvent(profile.logicalResourceId, { ...profile.physicalKey, attempt: 1 })
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
            operation: component === 'app-inbox' ? 'enqueueAndWaitForResult' : 'transaction'
        };
        const events = [event, { ...event, requestId: 'PRIVATE-unknown', details: {} }, {
            ...event,
            operation: 'PRIVATE-SQL-payload'
        }];
        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, budget, 65_536);
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { total: 3, retained: 0, rejected: 3, truncated: 0 } });
        expect(result.serialized).not.toContain('PRIVATE');
        const duplicate = { ...phase, commands: [...phase.commands, phase.commands[0]], timingEvents: [{ ...event, details: {} }] };
        const ambiguousRequest = computeStateWriteDiagnosticPhase(duplicate, budget, 65_536);
        expect(ambiguousRequest.complete).toBe(false);
        expect(readRecords(ambiguousRequest.serialized).at(-1)).toMatchObject({ timing: { total: 1, rejected: 1, retained: 0 } });
    });

    it.each(['app-inbox-phase', 'app-inbox'])('marks missing required %s request identity and contradictory identity incomplete', (component) => {
        const phase = createPhase();
        const event = {
            ...createEvent(profile.logicalResourceId, {}),
            component,
            operation: component === 'app-inbox' ? 'enqueueAndWaitForResult' : 'transaction'
        };
        const missing = { ...event, requestId: undefined };
        const contradictory = {
            ...createEvent(profile.physicalKey.resourceId, { ...profile.physicalKey }),
            component: 'app-inbox-handler',
            operation: 'GROUP_UPDATE'
        };
        const result = computeStateWriteDiagnosticPhase(
            { ...phase, timingEvents: [missing, contradictory, { ...event, details: { ...instance.physicalKey } }] },
            budget,
            65_536
        );
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { total: 3, rejected: 3, retained: 0 } });
        const ambiguousWorker = computeStateWriteDiagnosticPhase(
            { ...phase, serviceIds: ['PRIVATE-worker-b', 'PRIVATE-worker-b'], timingEvents: [event] },
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
