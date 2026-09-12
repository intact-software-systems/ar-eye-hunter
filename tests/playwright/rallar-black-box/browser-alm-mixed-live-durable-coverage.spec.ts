import { expect, test } from '@playwright/test';

import {
    classifyMixedLiveDurableSends,
    evaluateMixedLiveDurableCoverage,
    evaluateMixedLiveDurableExecutionBoundary,
    type MixedLiveDurableCoverageInput,
    type MixedLiveDurableCoverageObservation
} from './browser-alm-mixed-live-durable-coverage.ts';

test('rejects execution outside an explicit local memory single-worker boundary', () => {
    const remote = evaluateMixedLiveDurableExecutionBoundary({
        apiMode: 'postgres',
        nodeVersion: 'v26.8.2',
        apiBaseUrl: 'https://api.example.com',
        spaBaseUrl: 'https://app.example.com',
        workerCount: 2,
        runtimeSource: undefined,
        instrumentationSource: undefined
    });

    expect(remote.verdict).toBe('failed');
    expect(remote.reasons).toEqual(expect.arrayContaining([
        'api-mode-not-memory',
        'node-version-not-24',
        'api-endpoint-not-loopback',
        'spa-endpoint-not-loopback',
        'worker-count-not-one',
        'runtime-source-missing',
        'instrumentation-source-missing'
    ]));
});

test('rejects every observed effect for a refused durable identity', () => {
    const input = validCoverageInput();
    input.receiverObservation = observation({
        durableCallbacks: [{ identity: 'admitted' }, { identity: 'refused' }],
        completedDurableIdentities: ['admitted', 'refused'],
        queuePhases: [
            { identity: 'admitted', phase: 'queue-read' },
            { identity: 'admitted', phase: 'claim-reserved' },
            { identity: 'admitted', phase: 'release-completed' },
            { identity: 'refused', phase: 'release-completed' }
        ],
        liveObservations: [{ overlappingReturnedClaimIdentities: ['admitted'] }]
    });
    input.observations = { a: observation(), b: input.receiverObservation, c: observation() };
    input.terminalIdentities = [
        { identity: 'admitted', rowCount: 1, statuses: ['COMPLETED'], completed: true },
        { identity: 'refused', rowCount: 1, statuses: ['COMPLETED'], completed: true }
    ];

    const coverage = evaluateMixedLiveDurableCoverage(input);

    expect(coverage.verdict).toBe('failed');
    expect(coverage.reasons).toEqual(expect.arrayContaining([
        'refused-callback-observed',
        'refused-completed-release-observed',
        'refused-terminal-row-observed',
        'refused-queue-phase-observed'
    ]));
});

test('rejects a rate-limited send that retained an entry through the real classifier', () => {
    const input = validCoverageInput();
    input.durableSends = [
        { msgId: 'admitted', status: 'pending-admission', entryCount: 1 },
        { msgId: 'refused-with-entry', status: 'rate-limited', entryCount: 1 }
    ];
    input.durableDisposition = classifyMixedLiveDurableSends(input.durableSends);

    const coverage = evaluateMixedLiveDurableCoverage(input);

    expect(input.durableDisposition).toEqual({
        offeredCount: 2,
        admittedCount: 1,
        refusedCount: 0,
        unexpectedCount: 1
    });
    expect(coverage.verdict).toBe('failed');
    expect(coverage.reasons).toContain('unexpected-durable-disposition');
});

test('rejects an all-refused capture with no returned-claim overlap and censored readback', () => {
    const input = { ...validCoverageInput(), expectedDurableSendCount: 1 };
    input.durableSends = [{ msgId: 'refused', status: 'rate-limited', entryCount: 0 }];
    input.durableDisposition = {
        offeredCount: 1,
        admittedCount: 0,
        refusedCount: 1,
        unexpectedCount: 0
    };
    input.receiverObservation = observation({
        queuePhases: [
            { identity: 'other', phase: 'queue-read' },
            { identity: 'other', phase: 'claim-reserved' },
            { identity: 'other', phase: 'release-completed' }
        ],
        liveObservations: [],
        terminalReadbackCensoredByRowCapacity: true
    });
    input.observations = {
        a: observation(),
        b: input.receiverObservation,
        c: observation()
    };
    input.terminalIdentities = [{
        identity: 'refused',
        rowCount: 0,
        statuses: [],
        completed: false
    }];

    const coverage = evaluateMixedLiveDurableCoverage(input);

    expect(coverage.verdict).toBe('failed');
    expect(coverage.reasons).toEqual(expect.arrayContaining([
        'no-admitted-durable-work',
        'no-admitted-overlap',
        'terminal-readback-censored'
    ]));
});

test('does not accept a returned-claim witness for a non-admitted identity', () => {
    const input = validCoverageInput();
    input.receiverObservation = observation({
        durableCallbacks: [{ identity: 'admitted' }],
        completedDurableIdentities: ['admitted'],
        queuePhases: [
            { identity: 'admitted', phase: 'queue-read' },
            { identity: 'admitted', phase: 'claim-reserved' },
            { identity: 'admitted', phase: 'release-completed' }
        ],
        liveObservations: [{ overlappingReturnedClaimIdentities: ['refused'] }]
    });
    input.observations = { a: observation(), b: input.receiverObservation, c: observation() };

    const coverage = evaluateMixedLiveDurableCoverage(input);

    expect(coverage.verdict).toBe('failed');
    expect(coverage.reasons).toContain('no-admitted-overlap');
});

test('accepts retained pending admission completion beside a clean refused identity', () => {
    const input = validCoverageInput();
    const coverage = evaluateMixedLiveDurableCoverage(input);

    expect(classifyMixedLiveDurableSends(input.durableSends)).toEqual(input.durableDisposition);
    expect(coverage).toEqual({ verdict: 'passed', reasons: [] });
});

function validCoverageInput(): MutableCoverageInput {
    const receiver = observation({
        durableCallbacks: [{ identity: 'admitted' }],
        completedDurableIdentities: ['admitted'],
        queuePhases: [
            { identity: 'admitted', phase: 'queue-read' },
            { identity: 'admitted', phase: 'claim-reserved' },
            { identity: 'admitted', phase: 'release-completed' }
        ],
        liveObservations: [{ overlappingReturnedClaimIdentities: ['admitted'] }]
    });
    return {
        expectedDurableSendCount: 2,
        expectedLatestLiveSequence: 23,
        expectedDatabaseName: 'ar-eye-hunter-al-runtime',
        scenarioFailure: null,
        cleanupFailureCount: 0,
        readiness: [{ status: 'open', readyPeerCount: 2 }],
        durableSends: [
            { msgId: 'admitted', status: 'pending-admission', entryCount: 1 },
            { msgId: 'refused', status: 'rate-limited', entryCount: 0 }
        ],
        durableDisposition: { offeredCount: 2, admittedCount: 1, refusedCount: 1, unexpectedCount: 0 },
        liveAcceptedCount: 24,
        reconnect: { refreshContainedRoom: true, laneStatus: 'open', sendStatus: 'sent' },
        receiverProgress: { liveSequences: [23], postReconnectReceived: true },
        terminalIdentities: [
            { identity: 'admitted', rowCount: 1, statuses: ['COMPLETED'], completed: true },
            { identity: 'refused', rowCount: 0, statuses: [], completed: false }
        ],
        receiverObservation: receiver,
        observations: { a: observation(), b: receiver, c: observation() }
    };
}

interface MutableCoverageInput
    extends
        Omit<
            MixedLiveDurableCoverageInput,
            'durableSends' | 'durableDisposition' | 'terminalIdentities' | 'receiverObservation' | 'observations'
        > {
    durableSends: MixedLiveDurableCoverageInput['durableSends'];
    durableDisposition: MixedLiveDurableCoverageInput['durableDisposition'];
    terminalIdentities: MixedLiveDurableCoverageInput['terminalIdentities'];
    receiverObservation: MixedLiveDurableCoverageInput['receiverObservation'];
    observations: MixedLiveDurableCoverageInput['observations'];
}

function observation(input: Readonly<{
    durableCallbacks?: readonly { readonly identity: string; }[];
    completedDurableIdentities?: readonly string[];
    queuePhases?: readonly { readonly identity: string; readonly phase: string; }[];
    liveObservations?: readonly { readonly overlappingReturnedClaimIdentities: readonly string[]; }[];
    terminalReadbackCensoredByRowCapacity?: boolean;
}> = {}): MixedLiveDurableCoverageObservation {
    return {
        durableCallbacks: input.durableCallbacks ?? [],
        completedDurableIdentities: input.completedDurableIdentities ?? [],
        queuePhases: input.queuePhases ?? [],
        liveObservations: input.liveObservations ?? [],
        terminalReadbackCensoredByRowCapacity: input.terminalReadbackCensoredByRowCapacity ?? false,
        queueHookModuleIdentityObserved: true,
        nativeTiming: {
            capturedDatabaseNames: ['ar-eye-hunter-al-runtime'],
            uncapturedInFlightObservationCount: 0
        },
        droppedQueuePhaseCount: 0,
        droppedLiveObservationCount: 0,
        droppedDurableCallbackCount: 0,
        droppedInboundDiagnosticCount: 0,
        droppedOutboundDiagnosticCount: 0,
        droppedMarkedIdentityCount: 0,
        droppedReturnedClaimCount: 0,
        droppedCompletedIdentityCount: 0,
        methodsRestored: true
    };
}
