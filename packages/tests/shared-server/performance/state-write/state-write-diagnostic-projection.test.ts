import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { toStateWriteAppInboxExpectations } from '../../../../../apps/api-v1/scripts/perf/state-write/api-v1-state-write-app-inbox-evidence.ts';
import {
    computeStateWriteDiagnosticPhase,
    type StateWriteDiagnosticPhase
} from '../../../../../apps/api-v1/scripts/perf/state-write/state-write-diagnostic-projection.ts';

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

function readRecords(serialized: string): Record<string, unknown>[] {
    return serialized.trim() ? serialized.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

describe('state-write diagnostic projection', () => {
    it('joins interleaved physical and logical operations while separating origin, observer and clocks', () => {
        const phase = createPhase();
        const [profile, instance, config] = toStateWriteAppInboxExpectations(phase.commands, phase.scope, 5);
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
        expect(records.filter((record) => record.record === 'release').every((record) => record.observingStack === 'unavailable')).toBe(true);
        expect(result.serialized).not.toContain('PRIVATE');
    });

    it('rejects mismatched and ambiguous identities and unsupported labels without guessing missing attempts', () => {
        const phase = createPhase();
        const [profile] = toStateWriteAppInboxExpectations(phase.commands, phase.scope, 5);
        const events = [createEvent(profile.logicalResourceId, { ...profile.physicalKey, contextId: 'PRIVATE-wrong' }), {
            ...createEvent('PRIVATE-unknown', {}),
            operation: 'PRIVATE-SQL-payload'
        }];
        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: events }, budget, 65_536);
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { total: 2, retained: 0, rejected: 2, truncated: 0 } });
        expect(result.serialized).not.toContain('PRIVATE');
        const duplicate = { ...phase, commands: [...phase.commands, phase.commands[0]], timingEvents: [createEvent(profile.logicalResourceId, {})] };
        expect(computeStateWriteDiagnosticPhase(duplicate, budget, 65_536).complete).toBe(false);
    });

    it('marks missing required request identity and contradictory operation identity incomplete', () => {
        const phase = createPhase();
        const [profile] = toStateWriteAppInboxExpectations(phase.commands, phase.scope, 5);
        const missing = { ...createEvent(profile.logicalResourceId, {}), requestId: undefined };
        const contradictory = {
            ...createEvent(profile.physicalKey.resourceId, { ...profile.physicalKey }),
            component: 'app-inbox-handler',
            operation: 'GROUP_UPDATE'
        };
        const result = computeStateWriteDiagnosticPhase({ ...phase, timingEvents: [missing, contradictory] }, budget, 65_536);
        expect(result.complete).toBe(false);
        expect(readRecords(result.serialized).at(-1)).toMatchObject({ timing: { rejected: 2, retained: 0 } });
        const ambiguousWorker = computeStateWriteDiagnosticPhase(
            { ...phase, serviceIds: ['PRIVATE-worker-b', 'PRIVATE-worker-b'], timingEvents: [createEvent(profile.logicalResourceId, {})] },
            budget,
            65_536
        );
        expect(ambiguousWorker.complete).toBe(false);
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
        const [profile] = toStateWriteAppInboxExpectations(phase.commands, phase.scope, 5);
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
        const [profile] = toStateWriteAppInboxExpectations(phase.commands, phase.scope, 5);
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
