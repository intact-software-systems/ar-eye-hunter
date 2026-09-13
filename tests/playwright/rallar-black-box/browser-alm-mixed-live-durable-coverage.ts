import type { MixedLiveDurableTerminalIdentity } from './browser-alm-mixed-live-durable-observer.ts';

export interface MixedLiveDurableExecutionBoundaryInput {
    readonly apiMode: string | undefined;
    readonly nodeVersion: string;
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly workerCount: number;
    readonly runtimeSource: string | undefined;
    readonly instrumentationSource: string | undefined;
}

export interface MixedLiveDurableExecutionBoundary {
    readonly verdict: 'passed' | 'failed';
    readonly reasons: readonly string[];
    readonly apiMode: string;
    readonly nodeVersion: string;
    readonly apiBaseUrl: string;
    readonly spaBaseUrl: string;
    readonly workerCount: number;
    readonly runtimeSource: string;
    readonly instrumentationSource: string;
    readonly sourceVerification: 'operator-supplied-unverified';
}

export interface MixedLiveDurableCoverageInput {
    readonly expectedDurableSendCount: number;
    readonly expectedLatestLiveSequence: number;
    readonly expectedDatabaseName: string;
    readonly scenarioFailure: { readonly stage: string; readonly name: string; } | null;
    readonly cleanupFailureCount: number;
    readonly readiness: readonly { readonly status: string; readonly readyPeerCount: number; }[];
    readonly durableSends: readonly {
        readonly msgId: string;
        readonly status: string;
        readonly entryCount: number;
    }[];
    readonly durableDisposition: {
        readonly offeredCount: number;
        readonly admittedCount: number;
        readonly refusedCount: number;
        readonly unexpectedCount: number;
    } | null;
    readonly liveAcceptedCount: number | null;
    readonly reconnect: {
        readonly refreshContainedRoom: boolean;
        readonly laneStatus: string;
        readonly sendStatus: string;
    } | null;
    readonly receiverProgress: {
        readonly liveSequences: readonly number[];
        readonly postReconnectReceived: boolean;
    } | null;
    readonly terminalIdentities: readonly MixedLiveDurableTerminalIdentity[];
    readonly receiverObservation: MixedLiveDurableCoverageObservation | null;
    readonly observations: Readonly<Record<'a' | 'b' | 'c', MixedLiveDurableCoverageObservation | null>>;
}

export interface MixedLiveDurableCoverageObservation {
    readonly durableCallbacks: readonly { readonly identity: string; }[];
    readonly completedDurableIdentities: readonly string[];
    readonly queuePhases: readonly { readonly identity: string; readonly phase: string; }[];
    readonly liveObservations: readonly {
        readonly overlappingReturnedClaimIdentities: readonly string[];
    }[];
    readonly terminalReadbackCensoredByRowCapacity: boolean;
    readonly queueHookModuleIdentityObserved: boolean;
    readonly nativeTiming: {
        readonly capturedDatabaseNames: readonly string[];
        readonly uncapturedInFlightObservationCount: number;
    };
    readonly droppedQueuePhaseCount: number;
    readonly droppedLiveObservationCount: number;
    readonly droppedDurableCallbackCount: number;
    readonly droppedInboundDiagnosticCount: number;
    readonly droppedOutboundDiagnosticCount: number;
    readonly droppedMarkedIdentityCount: number;
    readonly droppedReturnedClaimCount: number;
    readonly droppedCompletedIdentityCount: number;
    readonly methodsRestored: boolean;
}

export interface MixedLiveDurableCoverage {
    readonly verdict: 'passed' | 'failed';
    readonly reasons: readonly string[];
}

export function classifyMixedLiveDurableSends(
    sends: MixedLiveDurableCoverageInput['durableSends']
): NonNullable<MixedLiveDurableCoverageInput['durableDisposition']> {
    const admittedCount = readAdmittedMixedLiveDurableIds(sends).length;
    const refusedCount = readRefusedMixedLiveDurableIds(sends).length;
    return {
        offeredCount: sends.length,
        admittedCount,
        refusedCount,
        unexpectedCount: sends.length - admittedCount - refusedCount
    };
}

export function readAdmittedMixedLiveDurableIds(
    sends: MixedLiveDurableCoverageInput['durableSends']
): readonly string[] {
    return sends
        .filter((send) => ['accepted', 'enqueued', 'pending-admission'].includes(send.status) && send.entryCount > 0)
        .map((send) => send.msgId);
}

export function evaluateMixedLiveDurableExecutionBoundary(
    input: MixedLiveDurableExecutionBoundaryInput
): MixedLiveDurableExecutionBoundary {
    const apiMode = input.apiMode?.trim() ?? '';
    const runtimeSource = input.runtimeSource?.trim() ?? '';
    const instrumentationSource = input.instrumentationSource?.trim() ?? '';
    const reasons = [
        ...(apiMode === 'memory' ? [] : ['api-mode-not-memory']),
        ...(/^v24\./u.test(input.nodeVersion) ? [] : ['node-version-not-24']),
        ...(isLoopbackUrl(input.apiBaseUrl) ? [] : ['api-endpoint-not-loopback']),
        ...(isLoopbackUrl(input.spaBaseUrl) ? [] : ['spa-endpoint-not-loopback']),
        ...(input.workerCount === 1 ? [] : ['worker-count-not-one']),
        ...(runtimeSource.length > 0 ? [] : ['runtime-source-missing']),
        ...(instrumentationSource.length > 0 ? [] : ['instrumentation-source-missing'])
    ];
    return {
        verdict: reasons.length === 0 ? 'passed' : 'failed',
        reasons,
        apiMode,
        nodeVersion: input.nodeVersion,
        apiBaseUrl: input.apiBaseUrl,
        spaBaseUrl: input.spaBaseUrl,
        workerCount: input.workerCount,
        runtimeSource,
        instrumentationSource,
        sourceVerification: 'operator-supplied-unverified'
    };
}

export function evaluateMixedLiveDurableCoverage(
    input: MixedLiveDurableCoverageInput
): MixedLiveDurableCoverage {
    const reasons = [
        ...evaluateScenarioProgress(input),
        ...evaluateDurableEffects(input),
        ...evaluateObservationIntegrity(input)
    ];
    return { verdict: reasons.length === 0 ? 'passed' : 'failed', reasons };
}

function evaluateScenarioProgress(input: MixedLiveDurableCoverageInput): readonly string[] {
    const disposition = input.durableDisposition;
    const admittedCount = readAdmittedMixedLiveDurableIds(input.durableSends).length;
    const refusedCount = readRefusedMixedLiveDurableIds(input.durableSends).length;
    return [
        ...(input.scenarioFailure === null ? [] : ['scenario-failure']),
        ...(input.cleanupFailureCount === 0 ? [] : ['cleanup-failure']),
        ...(input.readiness.length > 0 &&
                input.readiness.every((ready) => ready.status === 'open' && ready.readyPeerCount > 0)
            ? []
            : ['lane-readiness-missing']),
        ...(input.durableSends.length === input.expectedDurableSendCount ? [] : ['durable-send-count-mismatch']),
        ...(disposition?.offeredCount === input.expectedDurableSendCount ? [] : ['offered-count-mismatch']),
        ...(disposition?.admittedCount === admittedCount ? [] : ['admitted-count-mismatch']),
        ...(disposition?.refusedCount === refusedCount ? [] : ['refused-count-mismatch']),
        ...(disposition?.unexpectedCount === 0 ? [] : ['unexpected-durable-disposition']),
        ...(disposition !== null && disposition.admittedCount > 0 ? [] : ['no-admitted-durable-work']),
        ...(input.liveAcceptedCount !== null && input.liveAcceptedCount > 0 ? [] : ['no-live-send-progress']),
        ...(input.receiverProgress?.liveSequences.includes(input.expectedLatestLiveSequence) === true
            ? []
            : ['latest-live-not-received']),
        ...(input.reconnect?.refreshContainedRoom === true &&
                input.reconnect.laneStatus === 'open' && input.reconnect.sendStatus === 'sent'
            ? []
            : ['reconnect-progress-missing']),
        ...(input.receiverProgress?.postReconnectReceived === true ? [] : ['post-reconnect-not-received']),
        ...(input.terminalIdentities.length === input.expectedDurableSendCount
            ? []
            : ['terminal-identity-count-mismatch'])
    ];
}

function evaluateDurableEffects(input: MixedLiveDurableCoverageInput): readonly string[] {
    const receiver = input.receiverObservation;
    if (receiver === null) {
        return ['receiver-observation-missing', 'no-admitted-overlap'];
    }
    const admitted = new Set(readAdmittedMixedLiveDurableIds(input.durableSends));
    const refused = new Set(readRefusedMixedLiveDurableIds(input.durableSends));
    const callbackIds = new Set(receiver.durableCallbacks.map((callback) => callback.identity));
    const completedReleaseIds = new Set(receiver.completedDurableIdentities);
    const terminalByIdentity = new Map(input.terminalIdentities.map((identity) => [identity.identity, identity]));
    const queueIds = new Set(receiver.queuePhases.map((phase) => phase.identity));
    const admittedOverlap = receiver.liveObservations.some((live) =>
        live.overlappingReturnedClaimIdentities.some((identity) => admitted.has(identity))
    );
    return [
        ...([...admitted].every((identity) => callbackIds.has(identity)) ? [] : ['admitted-callback-missing']),
        ...([...admitted].every((identity) => completedReleaseIds.has(identity))
            ? []
            : ['admitted-completed-release-missing']),
        ...([...admitted].every((identity) => terminalByIdentity.get(identity)?.completed === true)
            ? []
            : ['admitted-terminal-completion-missing']),
        ...([...refused].every((identity) => !callbackIds.has(identity)) ? [] : ['refused-callback-observed']),
        ...([...refused].every((identity) => !completedReleaseIds.has(identity))
            ? []
            : ['refused-completed-release-observed']),
        ...([...refused].every((identity) => terminalByIdentity.get(identity)?.rowCount === 0)
            ? []
            : ['refused-terminal-row-observed']),
        ...([...refused].every((identity) => !queueIds.has(identity)) ? [] : ['refused-queue-phase-observed']),
        ...(admittedOverlap ? [] : ['no-admitted-overlap'])
    ];
}

function evaluateObservationIntegrity(input: MixedLiveDurableCoverageInput): readonly string[] {
    const receiver = input.receiverObservation;
    const observations = Object.values(input.observations);
    const dropCount = observations.reduce(
        (total, observation) => total + (observation === null ? 0 : observationDropCount(observation)),
        0
    );
    const phases = new Set(receiver?.queuePhases.map((phase) => phase.phase) ?? []);
    return [
        ...(receiver !== null &&
                ['queue-read', 'claim-reserved', 'release-completed'].every((phase) => phases.has(phase))
            ? []
            : ['required-queue-phase-missing']),
        ...(receiver?.nativeTiming.capturedDatabaseNames.length === 1 &&
                receiver.nativeTiming.capturedDatabaseNames[0] === input.expectedDatabaseName
            ? []
            : ['native-database-scope-mismatch']),
        ...(receiver?.queueHookModuleIdentityObserved === true ? [] : ['queue-module-identity-missing']),
        ...(receiver?.terminalReadbackCensoredByRowCapacity === false ? [] : ['terminal-readback-censored']),
        ...(dropCount === 0 ? [] : ['observation-capacity-dropped']),
        ...(observations.every((observation) => observation?.methodsRestored === true)
            ? []
            : ['observation-methods-not-restored']),
        ...(observations.every((observation) => observation?.nativeTiming.uncapturedInFlightObservationCount === 0)
            ? []
            : ['native-observation-in-flight'])
    ];
}

function observationDropCount(observation: MixedLiveDurableCoverageObservation): number {
    return observation.droppedQueuePhaseCount + observation.droppedLiveObservationCount +
        observation.droppedDurableCallbackCount + observation.droppedInboundDiagnosticCount +
        observation.droppedOutboundDiagnosticCount + observation.droppedMarkedIdentityCount +
        observation.droppedReturnedClaimCount + observation.droppedCompletedIdentityCount;
}

function readRefusedMixedLiveDurableIds(sends: MixedLiveDurableCoverageInput['durableSends']): readonly string[] {
    return sends
        .filter((send) => send.status === 'rate-limited' && send.entryCount === 0)
        .map((send) => send.msgId);
}

function isLoopbackUrl(value: string): boolean {
    try {
        const hostname = new URL(value).hostname;
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    }
    catch {
        return false;
    }
}
