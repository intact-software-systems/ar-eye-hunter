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
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { toClientMutationIssuedSessionAuthority } from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { toAuthenticatedGroupMutationQueueKey } from '@shared-server/rallar-system/group-state/inbox/to-authenticated-group-mutation-queue-key.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { decodeJsonWireText, type JsonWireObject } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { EntityStatus, type Key } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    computeStateWriteDiagnosticPhase,
    STATE_WRITE_DIAGNOSTIC_BUDGET,
    type StateWriteDiagnosticPhase
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts';
import { createBenchmarkAuthSession } from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-workload.ts';
import { TestResourceInbox } from '../../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxQueueMessageFixture } from '../../rallar-system/app-inbox/test-support/create-app-inbox-queue-message-fixture.ts';
import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

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
        contextId: 'PRIVATE-application:PRIVATE-workspace:group-1'
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

function createSqlEvent(): RallarTimingEvent {
    return {
        type: 'rallar.timing',
        component: 'state-write-benchmark-sql',
        operation: 'read',
        status: 'ok',
        durationMs: 12.34,
        atEpochMs: 1_700_000_000_000,
        details: { sql: 'PRIVATE-æøå-🧪', parameters: 'PRIVATE-payload' }
    };
}

function createRelease(): ResourceInboxAttemptReleaseTelemetry {
    return {
        key: profile.physicalKey,
        type: 'APP_INBOX',
        resource: 'PRIVATE-æøå-🧪',
        attempt: 1,
        selectedLane: Reservator.NEW,
        queueAgeMs: 40,
        dueAgeMs: 3,
        classification: 'accepted' as const,
        status: EntityStatus.COMPLETED,
        retryDelayMs: 0,
        failure: { kind: 'none' as const }
    };
}

describe('state-write diagnostic projection', () => {
    it('retains native transaction-owned counters without exposing unapproved timing details', () => {
        const events = [
            createEvent(profile.logicalResourceId, {
                ...profile.physicalKey,
                attempt: 2,
                statements: 4,
                executorWaitMs: 20.75,
                beginWaitMs: 3.5,
                privatePayload: 'PRIVATE-payload'
            }),
            {
                ...createEvent(profile.logicalResourceId, { ...profile.physicalKey, statements: 0, executorWaitMs: 0, beginWaitMs: 0 }),
                status: 'error' as const
            },
            createEvent(profile.logicalResourceId, profile.physicalKey)
        ];

        const result = computeStateWriteDiagnosticPhase({ ...createPhase(), timingEvents: events }, budget, budget.bytesPerRun);
        const timings = readRecords(result.serialized).filter((record) => record.record === 'timing');

        expect(result.complete).toBe(true);
        expect(timings[0]).toMatchObject({
            executorCounters: { availability: 'available', statements: 4, executorWaitMs: 20.75, beginWaitMs: 3.5 },
            association: { kind: 'command-operation', commandOrdinal: 0, operation: 'profile', attempt: 2 }
        });
        expect(timings[1]).toMatchObject({
            status: 'error',
            executorCounters: { availability: 'available', statements: 0, executorWaitMs: 0, beginWaitMs: 0 }
        });
        expect(timings[2]).toMatchObject({ executorCounters: { availability: 'unavailable' } });
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it.each([
        { statements: 2 },
        { statements: -1, executorWaitMs: 0, beginWaitMs: 0 },
        { statements: 0.5, executorWaitMs: 0, beginWaitMs: 0 },
        { statements: Number.MAX_SAFE_INTEGER + 1, executorWaitMs: 0, beginWaitMs: 0 },
        { statements: 2, executorWaitMs: NaN, beginWaitMs: 0 },
        { statements: 2, executorWaitMs: 0, beginWaitMs: Infinity },
        { statements: 2, executorWaitMs: -1, beginWaitMs: 0 },
        { statements: 2, executorWaitMs: 0, beginWaitMs: -1 }
    ])('marks incomplete or malformed transaction counters as incomplete evidence: %j', (counters) => {
        const result = computeStateWriteDiagnosticPhase(
            {
                ...createPhase(),
                timingEvents: [createEvent(profile.logicalResourceId, { ...profile.physicalKey, ...counters })]
            },
            budget,
            budget.bytesPerRun
        );

        expect(result.complete).toBe(false);
        const records = readRecords(result.serialized);
        expect(records.filter((record) => record.record === 'timing')).toEqual([]);
        expect(records.at(-1)).toMatchObject({ timing: { total: 1, retained: 0, rejected: 1, truncated: 0 } });
    });

    it('retains the real client read phases with their command association and rejects contradictory identities', async () => {
        const phase = createPhase();
        const principalId = 'client-0';
        const session = createBenchmarkAuthSession(phase.scope, principalId, 'client-session-0');
        const command = toClientMutationCommand(
            toUpsertClientPrincipalMutationInput({
                scope: phase.scope,
                principalId,
                request: { username: principalId, requestId: profile.logicalResourceId },
                defaultCommandId: profile.logicalResourceId
            }),
            {
                traceId: 'trace-state-write-diagnostic-projection',
                nowEpochMs: session.issuedAtEpochMs,
                serviceId: 'PRIVATE-worker-b',
                eventId: 'PRIVATE-read-event',
                attemptCount: 1,
                expireAtEpochMs: session.expiresAtEpochMs,
                disconnectedSessionRetentionMs: 60_000
            },
            toClientMutationIssuedSessionAuthority(session, phase.scope, 'upsertPrincipal')
        );
        const events: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            clientStateEventStore: new InMemoryClientStateEventStore(),
            serviceId: 'PRIVATE-worker-b',
            timing: (event) => events.push(event)
        });
        await service.read(command);

        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, budget, 65_536);

        expect(result.complete).toBe(true);
        const records = readRecords(result.serialized);
        expect(records.filter((record) => record.record === 'timing').map((record) => record.operation)).toEqual(
            expect.arrayContaining([
                'mutation.read-state',
                'mutation.read-receipt',
                'mutation.read-audience-groups',
                'mutation.read-audience-clients',
                'mutation.read'
            ])
        );
        for (const record of records.filter((entry) => entry.record === 'timing')) {
            expect(record.association).toEqual({
                kind: 'command-operation',
                commandOrdinal: 0,
                operation: 'profile',
                originatingStack: 0,
                observingStack: 1,
                attempt: 'unavailable'
            });
        }
        expect(records.at(-1)).toMatchObject({ timing: { total: 5, retained: 5, rejected: 0, truncated: 0 } });
        expect(result.serialized).not.toContain('PRIVATE');
        expect(result.serialized).not.toContain(principalId);

        const contradictions = events.flatMap((event) => [
            { ...event, requestId: 'PRIVATE-unknown' },
            { ...event, applicationId: 'PRIVATE-wrong-application' },
            { ...event, workspaceId: 'PRIVATE-wrong-workspace' },
            { ...event, serviceId: 'PRIVATE-unknown-worker' },
            { ...event, principalId: 'PRIVATE-wrong-principal' },
            { ...event, details: { topicId: 'GROUP_UPDATE' } }
        ]);
        const rejected = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: contradictions }, budget, 65_536);
        expect(rejected.complete).toBe(false);
        expect(readRecords(rejected.serialized).at(-1)).toMatchObject({
            timing: { total: 30, retained: 0, rejected: 30, truncated: 0 }
        });
    });

    it.each(['profile', 'instance'] as const)('retains only matching %s principal and mutation identity', (operation) => {
        const entry = operation === 'profile' ? profile : instance;
        const mutationOperation = operation === 'profile' ? 'upsertPrincipal' : 'upsertInstance';
        const event = {
            ...createEvent(entry.logicalResourceId, { ...entry.physicalKey, mutationOperation }),
            component: 'client-state-service',
            operation: 'mutation.compute',
            principalId: 'client-0'
        };
        const result = computeStateWriteDiagnosticPhase(
            {
                ...createPhase(),
                timingEvents: [
                    event,
                    { ...event, principalId: 'PRIVATE-wrong-principal' },
                    { ...event, details: { ...event.details, mutationOperation: operation === 'profile' ? 'upsertInstance' : 'upsertPrincipal' } }
                ]
            },
            budget,
            65_536
        );

        expect(result.complete).toBe(false);
        const records = readRecords(result.serialized);
        expect(records.at(-1)).toMatchObject({ timing: { total: 3, retained: 1, rejected: 2, truncated: 0 } });
        expect(records.find((record) => record.record === 'timing')?.association).toEqual({
            kind: 'command-operation',
            commandOrdinal: 0,
            operation,
            originatingStack: 0,
            observingStack: 1,
            attempt: 'unavailable'
        });
        expect(result.serialized).not.toContain('PRIVATE');
        expect(result.serialized).not.toContain('client-0');
    });

    it('rejects client read timing attributed to a known group command', () => {
        const events = ['mutation.read', 'mutation.read-state'].map((operation) => ({
            ...createEvent(config.physicalKey.resourceId, config.physicalKey),
            component: 'client-state-service',
            operation
        }));

        const result = computeStateWriteDiagnosticPhase({ ...createPhase(), timingEvents: events }, budget, 65_536);

        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { total: 2, retained: 0, rejected: 2 } });
    });

    it.each([-Number.MAX_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER])('retains signed observation %s with redacted not-ready identity', (duration) => {
        const release: ResourceInboxAttemptReleaseTelemetry = {
            ...createRelease(),
            selectedLane: Reservator.RETRY,
            classification: 'not-ready',
            status: EntityStatus.RETRY,
            reservationObservation: {
                key: { ...profile.physicalKey },
                reservationAttempt: 2,
                availability: 'available',
                boundary: 'postgres-update-returning',
                association: 'physical-key-and-reservation-attempt',
                previousPersistedRetryDelayUs: duration,
                dueToReservationObservationUs: duration
            }
        };
        const result = computeStateWriteDiagnosticPhase({ ...createPhase(), releases: [release] }, budget, 65_536);
        expect(result.complete).toBe(true);
        expect(readRecords(result.serialized).find((record) => record.record === 'release')).toMatchObject({
            attempt: 1,
            reservationObservation: { reservationAttempt: 2, previousPersistedRetryDelayUs: duration, dueToReservationObservationUs: duration }
        });
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ reservationObservations: { expected: 1, available: 1, unavailable: 0 } });
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it('marks expected missing retry evidence incomplete and discloses uncaptured lanes', () => {
        const retry = computeStateWriteDiagnosticPhase(
            { ...createPhase(), releases: [{ ...createRelease(), selectedLane: Reservator.RETRY }] },
            budget,
            65_536
        );
        expect(retry.complete).toBe(false);
        expect(readRecords(retry.serialized).at(-1)).toMatchObject({ reservationObservations: { expected: 1, available: 0, unavailable: 1 } });
        for (const selectedLane of [Reservator.FAIRNESS, Reservator.TIMEOUT, Reservator.FINALIZATION]) {
            const result = computeStateWriteDiagnosticPhase({ ...createPhase(), releases: [{ ...createRelease(), selectedLane }] }, budget, 65_536);
            expect(result.complete).toBe(true);
            expect(readRecords(result.serialized).find((record) => record.record === 'release')).toMatchObject({
                reservationObservation: { availability: 'unavailable', reason: 'lane-not-captured' }
            });
        }
    });

    it.each(['lane', 'boundary', 'attempt', 'range', 'fraction'])('rejects contradictory observation %s', (fault) => {
        const release: ResourceInboxAttemptReleaseTelemetry = {
            ...createRelease(),
            selectedLane: fault === 'lane' ? Reservator.NEW : Reservator.RETRY,
            reservationObservation: {
                key: profile.physicalKey,
                reservationAttempt: fault === 'attempt' ? 2 : 1,
                availability: 'available',
                boundary: 'postgres-update-returning',
                association: 'physical-key-and-reservation-attempt',
                previousPersistedRetryDelayUs: fault === 'range' ? Number.MAX_SAFE_INTEGER + 1 : 1,
                dueToReservationObservationUs: fault === 'fraction' ? 0.5 : 1
            }
        };
        if (fault === 'boundary') {
            Object.assign(release.reservationObservation!, { boundary: 'handler' });
        }
        const result = computeStateWriteDiagnosticPhase({ ...createPhase(), releases: [release] }, budget, 65_536);
        expect(result.complete).toBe(false);
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it('counts truncated ordinary retries as expected unavailable observations', () => {
        const result = computeStateWriteDiagnosticPhase(
            { ...createPhase(), releases: [{ ...createRelease(), selectedLane: Reservator.RETRY }] },
            { ...budget, eventsPerPhase: 0 },
            65_536
        );
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({
            releases: { total: 1, retained: 0, truncated: 1 },
            reservationObservations: { expected: 1, available: 0, unavailable: 1 }
        });
    });

    it.each(['phase', 'remaining-run'])('counts a RETRY omitted by the %s byte limit as unavailable', (limit) => {
        const release: ResourceInboxAttemptReleaseTelemetry = {
            ...createRelease(),
            selectedLane: Reservator.RETRY,
            reservationObservation: {
                key: profile.physicalKey,
                reservationAttempt: 1,
                availability: 'available',
                boundary: 'postgres-update-returning',
                association: 'physical-key-and-reservation-attempt',
                previousPersistedRetryDelayUs: 5_000_000,
                dueToReservationObservationUs: 3_000_000
            }
        };
        const phase = { ...createPhase(), releases: [release] };
        expect(computeStateWriteDiagnosticPhase(phase, budget, 65_536).complete).toBe(true);
        const result = computeStateWriteDiagnosticPhase(
            phase,
            { ...budget, bytesPerPhase: limit === 'phase' ? 2_048 : budget.bytesPerPhase },
            limit === 'remaining-run' ? 2_048 : 65_536
        );
        const records = readRecords(result.serialized);
        expect(result.complete).toBe(false);
        expect(records.filter((record) => record.record === 'release')).toHaveLength(0);
        expect(records.at(-1)).toMatchObject({
            releases: { total: 1, retained: 0, truncated: 1 },
            reservationObservations: { expected: 1, available: 0, unavailable: 1 }
        });
    });

    it('retains the complete SQL-heavy stream and late command facts where redundant timing rows overflow', () => {
        const sql = createSqlEvent();
        const events: RallarTimingEvent[] = [
            ...Array.from({ length: 1_000 }, () => sql),
            { ...sql, component: 'state-write-benchmark-phase', operation: 'transaction', status: 'error' },
            createEvent(profile.logicalResourceId, { ...profile.physicalKey, attempt: 2, queueAgeMs: 42.5, dueAgeMs: 3.25 })
        ];
        const input = { ...createPhase(), timingEvents: events, releases: [createRelease()] };
        const original = JSON.stringify(input);
        const result = computeStateWriteDiagnosticPhase(input, { ...budget, eventsPerPhase: 1_003, bytesPerPhase: 320_000 }, 320_000);
        const records = readRecords(result.serialized);
        const timings = records.filter((record) => record.record === 'timing');
        expect(result.complete).toBe(true);
        expect(records[0]).toMatchObject({ schema: 'rallar.state-write.diagnostic.v3', eventStart: 'approximate-completion-minus-rounded-duration' });
        expect(timings).toHaveLength(1_002);
        expect(timings.slice(0, 1_000)).toEqual(Array.from({ length: 1_000 }, () => ({
            record: 'timing',
            component: 'state-write-benchmark-sql',
            operation: 'read',
            status: 'ok',
            completedAtEpochMs: 1_700_000_000_000,
            roundedDurationMs: 12.34,
            association: { kind: 'process-unassociated', reason: 'sql-process-scope', observingStack: 'unavailable' },
            queueAgeMs: 'unavailable',
            dueAgeMs: 'unavailable'
        })));
        expect(timings.at(-2)).toMatchObject({ component: 'state-write-benchmark-phase', operation: 'transaction', status: 'error' });
        expect(timings.at(-1)).toEqual({
            record: 'timing',
            component: 'app-inbox-phase',
            operation: 'transaction',
            status: 'ok',
            completedAtEpochMs: 99_999,
            roundedDurationMs: 12.34,
            association: { kind: 'command-operation', commandOrdinal: 0, operation: 'profile', originatingStack: 0, observingStack: 1, attempt: 2 },
            queueAgeMs: 42.5,
            dueAgeMs: 3.25,
            executorCounters: { availability: 'unavailable' }
        });
        expect(Number(timings[0]!.completedAtEpochMs) - Number(timings[0]!.roundedDurationMs)).toBe(1_699_999_999_987.66);
        expect(Number(timings.at(-1)!.completedAtEpochMs) - Number(timings.at(-1)!.roundedDurationMs)).toBe(99_986.66);
        const redundant = records.map((record) =>
            record.record === 'timing'
                ? {
                    ...record,
                    approximateStartedAtEpochMs: Number(record.completedAtEpochMs) - Number(record.roundedDurationMs),
                    statusMeaning: 'timed-operation-status'
                }
                : record
        ).map((record) => JSON.stringify(record) + '\n').join('');
        expect(new TextEncoder().encode(redundant).length).toBeGreaterThan(320_000);
        expect(result.bytes).toBe(new TextEncoder().encode(result.serialized).length);
        expect(result.bytes).toBeLessThanOrEqual(320_000);
        expect(records.at(-1)).toEqual({
            record: 'completeness',
            reservationObservations: { expected: 0, available: 0, unavailable: 0 },
            complete: true,
            timing: { total: 1_002, retained: 1_002, rejected: 0, truncated: 0, unassociated: 1_001 },
            releases: { total: 1, retained: 1, rejected: 0, truncated: 0, unassociated: 0 },
            boundaries: { total: 5, retained: 5, rejected: 0, truncated: 0, unassociated: 0 }
        });
        expect(JSON.stringify(input)).toBe(original);
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it.each([
        { timings: 99_803, ceiling: 100_000, retained: 98_618, truncated: 1_185 },
        { timings: 99_803, ceiling: undefined, retained: 99_803, truncated: 0 },
        { timings: 108_618, ceiling: undefined, retained: 108_618, truncated: 0 },
        { timings: 108_619, ceiling: undefined, retained: 108_618, truncated: 1 }
    ])('accounts for $timings timing events and 1,382 releases at ceiling $ceiling', ({ timings, ceiling, retained, truncated }) => {
        const result = computeStateWriteDiagnosticPhase(
            {
                ...createPhase(),
                timingEvents: Array.from({ length: timings }, () => ({ ...createSqlEvent(), atEpochMs: 100, durationMs: 1 })),
                releases: Array.from({ length: 1_382 }, createRelease)
            },
            { ...STATE_WRITE_DIAGNOSTIC_BUDGET, eventsPerPhase: ceiling ?? STATE_WRITE_DIAGNOSTIC_BUDGET.eventsPerPhase },
            536_869_888
        );
        expect(result.complete).toBe(truncated === 0);
        expect(readRecords(result.serialized).at(-1)).toEqual({
            record: 'completeness',
            reservationObservations: { expected: 0, available: 0, unavailable: 0 },
            complete: truncated === 0,
            timing: { total: timings, retained, truncated, rejected: 0, unassociated: retained },
            releases: { total: 1_382, retained: 1_382, rejected: 0, truncated: 0, unassociated: 0 },
            boundaries: { total: 5, retained: 5, rejected: 0, truncated: 0, unassociated: 0 }
        });
        expect(result.bytes).toBe(new TextEncoder().encode(result.serialized).length);
        expect(result.bytes).toBeLessThanOrEqual(33_554_432);
    });

    it('keeps rejected associations distinct from truncation in mixed incomplete output', () => {
        const result = computeStateWriteDiagnosticPhase(
            {
                ...createPhase(),
                releases: [{ ...createRelease(), key: { ...profile.physicalKey, resourceId: 'PRIVATE-invalid' } }, createRelease()],
                timingEvents: [createEvent('PRIVATE-unknown', {}), createSqlEvent(), createSqlEvent()]
            },
            { ...budget, eventsPerPhase: 2 },
            65_536
        );
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({
            timing: { total: 3, retained: 1, rejected: 1, truncated: 1, unassociated: 2 },
            releases: { total: 2, retained: 1, rejected: 1, truncated: 0, unassociated: 1 }
        });
    });

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
                        newLaneConcurrency: 1
                    }, Temporal.Now.instant),
                    newResourceId: () => 'PRIVATE-generated',
                    createMessage: createAppInboxQueueMessageFixture
                }, { serviceId: 'PRIVATE-worker-a', defaultTopicId: 'app-inbox.client-state' }),
                reservationClient: {
                    reserveMaterializedEntry: async () => {
                        throw new Error('The diagnostic workload enqueues through the queue writer');
                    }
                },
                resultWaiter: {
                    waitForResult: async <Result>(
                        written: AppInboxResultWaiter.Wait,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        persistedKeys.push(written.key);
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
            const physicalKey = toQueuedPhysicalKey(enqueue);
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
            details: { ...event.details, ...toQueuedPhysicalKey(enqueues[ordinal]!) }
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
            roundedDurationMs: 12.34
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
                reservationObservation: {
                    availability: 'unavailable',
                    boundary: 'unavailable',
                    association: 'unavailable',
                    reservationAttempt: 2,
                    reason: 'not-applicable'
                },
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
                reservationObservation: {
                    availability: 'unavailable',
                    boundary: 'unavailable',
                    association: 'unavailable',
                    reservationAttempt: 1,
                    reason: 'not-applicable'
                },
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
                reservationObservation: {
                    availability: 'unavailable',
                    boundary: 'unavailable',
                    association: 'unavailable',
                    reservationAttempt: 1,
                    reason: 'not-applicable'
                },
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

    it.each(['read', 'readWithSnapshot'])('associates a group-state-service %s line with its command', (operation) => {
        const events = [{
            ...createEvent(config.physicalKey.resourceId, { ...config.physicalKey }),
            component: 'group-state-service',
            operation
        }];

        const result = computeStateWriteDiagnosticPhase({ ...createPhase(), timingEvents: events }, budget, 65_536);

        expect(readRecords(result.serialized).filter((record) => record.record === 'timing').map((record) => record.association))
            .toEqual([
                { kind: 'command-operation', commandOrdinal: 1, operation: 'command', originatingStack: 1, observingStack: 1, attempt: 'unavailable' }
            ]);
    });

    it('keeps process transaction status separate from command association', () => {
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
            component: 'state-write-benchmark-phase',
            status: 'ok',
            association: { kind: 'process-unassociated', reason: 'sql-process-scope' }
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

/** The key each command is queued under: an authenticated group command is reserved under its strict key. */
function toQueuedPhysicalKey(enqueue: AppInboxEnqueueInput): Key {
    return enqueue.type === AppInboxType.GROUP_UPDATE
        ? toAuthenticatedGroupMutationQueueKey(enqueue)
        : toPhysicalAppInboxQueueKey({ ...enqueue, resourceId: enqueue.resourceId! });
}
