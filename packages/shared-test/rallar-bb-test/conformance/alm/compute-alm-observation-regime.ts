import type {
    ALMObservationCommandResult,
    ALMObservationRtcLifecycle,
    ALMObservationSnapshot,
    ALMObservationStorageCounters
} from './alm-observation-snapshot.ts';

/**
 * Seven hosted observation runs (2026-09-10/11) separate a runner that completes the lane from one
 * that cannot: every head whose rtc cell opened at or below 24 ms per admission read operation went
 * 6 ready / 0 timeout, and every head at or above 36 ms went 0 ready / 6 timeout — including a
 * same-day re-execution of a green head, which failed identically. The band between the two
 * constants stays unclassified rather than guessed. The measurement is confined to the cell's
 * opening window and to `send`-origin commits so that it reads the runner rather than the cell: a
 * failing cell's own degradation dominates a whole-cell median, and a drain's commit measures a
 * different read chain than a caller's own admission.
 */
export const ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION = 30;
export const ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION = 35;
export const ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT = 5;
export const ALM_OBSERVATION_WINDOW_MS = 20_000;
export const ALM_OBSERVATION_COMMIT_ORIGIN = 'send';

export type ALMObservationRegimeName = 'normal' | 'slow' | 'unclassified';

export type ALMObservationCellOutcome = 'passed' | 'failed';

export type ALMObservationPerOperation =
    | Readonly<{ outcome: 'measured'; medianMs: number; sampleCount: number; }>
    | Readonly<{ outcome: 'too-few-samples'; sampleCount: number; }>;

export type ALMObservationPeerReadiness =
    | Readonly<{ outcome: 'ready'; sessionId: string; peerId: string; readinessMs: number; }>
    | Readonly<{ outcome: 'never-ready'; sessionId: string; peerId: string; observedMs: number; }>;

export type ALMObservationWorkPageRate =
    | Readonly<{ outcome: 'measured'; perSecond: number; readingCount: number; spanMs: number; }>
    | Readonly<{ outcome: 'too-few-readings'; readingCount: number; }>;

export interface ALMObservationRegime {
    readonly runId: string;
    readonly carrier: string;
    readonly scope: string;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly regime: ALMObservationRegimeName;
    readonly windowMs: number;
    readonly perOperation: ALMObservationPerOperation;
    readonly peerReadiness: readonly ALMObservationPeerReadiness[];
    readonly scenarioSends: readonly ALMObservationCommandResult[];
    readonly workPageRate: ALMObservationWorkPageRate;
    readonly snapshotIssues: readonly string[];
}

export interface ALMObservationRegimeInput {
    readonly snapshot: ALMObservationSnapshot;
    readonly carrier: string;
    readonly scope: string;
    readonly cellOutcome: ALMObservationCellOutcome;
}

export interface UnreadableALMObservationRegimeInput {
    readonly carrier: string;
    readonly scope: string;
    readonly cellOutcome: ALMObservationCellOutcome;
    readonly snapshotIssues: readonly string[];
}

interface ALMObservationPeerObservation {
    readonly sessionId: string;
    readonly peerId: string;
    knownAtEpochMs: number;
    readyAtEpochMs: number | undefined;
}

export function computeALMObservationRegime(input: ALMObservationRegimeInput): ALMObservationRegime {
    const perOperation = computePerOperationCost(input.snapshot);
    return {
        runId: input.snapshot.runId,
        carrier: input.carrier,
        scope: input.scope,
        cellOutcome: input.cellOutcome,
        regime: resolveRegimeName(perOperation),
        windowMs: ALM_OBSERVATION_WINDOW_MS,
        perOperation,
        peerReadiness: computePeerReadiness(input.snapshot.rtcLifecycles),
        scenarioSends: input.snapshot.commandResults,
        workPageRate: computeWorkPageRate(input.snapshot.storageCounters),
        snapshotIssues: []
    };
}

/** The regime a cell whose snapshot could not be read still records, so every cell leaves a file. */
export function createUnreadableALMObservationRegime(
    input: UnreadableALMObservationRegimeInput
): ALMObservationRegime {
    return {
        runId: '',
        carrier: input.carrier,
        scope: input.scope,
        cellOutcome: input.cellOutcome,
        regime: 'unclassified',
        windowMs: ALM_OBSERVATION_WINDOW_MS,
        perOperation: { outcome: 'too-few-samples', sampleCount: 0 },
        peerReadiness: [],
        scenarioSends: [],
        workPageRate: { outcome: 'too-few-readings', readingCount: 0 },
        snapshotIssues: input.snapshotIssues
    };
}

export function toALMObservationRegimeSummary(regime: ALMObservationRegime): string {
    const perOperation = regime.perOperation.outcome === 'measured'
        ? `${regime.perOperation.medianMs} ms/op over ${regime.perOperation.sampleCount} commits`
        : `unmeasured (${regime.perOperation.sampleCount} commits)`;
    return `ALM observation ${regime.carrier}-${regime.scope}: regime=${regime.regime} ` +
        `perOperation=${perOperation} outcome=${regime.cellOutcome}`;
}

function computePerOperationCost(snapshot: ALMObservationSnapshot): ALMObservationPerOperation {
    const windowEndEpochMs = snapshot.firstEventAtEpochMs + ALM_OBSERVATION_WINDOW_MS;
    const costs = snapshot.commitPhases
        .filter((phase) => phase.origin === ALM_OBSERVATION_COMMIT_ORIGIN && phase.atEpochMs <= windowEndEpochMs)
        .map((phase) => phase.readDurationMs / phase.readOperationCount);
    return costs.length < ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT
        ? { outcome: 'too-few-samples', sampleCount: costs.length }
        : { outcome: 'measured', medianMs: toTwoDecimals(computeMedian(costs)), sampleCount: costs.length };
}

function resolveRegimeName(perOperation: ALMObservationPerOperation): ALMObservationRegimeName {
    if (perOperation.outcome === 'too-few-samples') {
        return 'unclassified';
    }
    if (perOperation.medianMs < ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION) {
        return 'normal';
    }
    return perOperation.medianMs >= ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION
        ? 'slow'
        : 'unclassified';
}

function computePeerReadiness(
    lifecycles: readonly ALMObservationRtcLifecycle[]
): readonly ALMObservationPeerReadiness[] {
    const ordered = [...lifecycles].sort((left, right) => left.atEpochMs - right.atEpochMs);
    const observations = new Map<string, ALMObservationPeerObservation>();
    let lastAtEpochMs = 0;
    for (const lifecycle of ordered) {
        lastAtEpochMs = lifecycle.atEpochMs;
        for (const peerId of lifecycle.knownPeerIds) {
            rememberPeerKnown(observations, lifecycle, peerId);
        }
        for (const peerId of lifecycle.readyPeerIds) {
            rememberPeerReady(observations, lifecycle, peerId);
        }
    }
    return [...observations.values()].map((observation) => toPeerReadiness(observation, lastAtEpochMs));
}

function rememberPeerKnown(
    observations: Map<string, ALMObservationPeerObservation>,
    lifecycle: ALMObservationRtcLifecycle,
    peerId: string
): void {
    const key = toPeerKey(lifecycle.sessionId, peerId);
    if (!observations.has(key)) {
        observations.set(key, {
            sessionId: lifecycle.sessionId,
            peerId,
            knownAtEpochMs: lifecycle.atEpochMs,
            readyAtEpochMs: undefined
        });
    }
}

function rememberPeerReady(
    observations: Map<string, ALMObservationPeerObservation>,
    lifecycle: ALMObservationRtcLifecycle,
    peerId: string
): void {
    rememberPeerKnown(observations, lifecycle, peerId);
    const observation = observations.get(toPeerKey(lifecycle.sessionId, peerId));
    if (observation !== undefined && observation.readyAtEpochMs === undefined) {
        observation.readyAtEpochMs = lifecycle.atEpochMs;
    }
}

/** Both halves are opaque `session-` tokens, so a space cannot collide across the pair. */
function toPeerKey(sessionId: string, peerId: string): string {
    return `${sessionId} ${peerId}`;
}

function toPeerReadiness(
    observation: ALMObservationPeerObservation,
    lastAtEpochMs: number
): ALMObservationPeerReadiness {
    const { sessionId, peerId, knownAtEpochMs, readyAtEpochMs } = observation;
    return readyAtEpochMs === undefined
        ? { outcome: 'never-ready', sessionId, peerId, observedMs: lastAtEpochMs - knownAtEpochMs }
        : { outcome: 'ready', sessionId, peerId, readinessMs: readyAtEpochMs - knownAtEpochMs };
}

function computeWorkPageRate(
    readings: readonly ALMObservationStorageCounters[]
): ALMObservationWorkPageRate {
    const ordered = [...readings].sort((left, right) => left.atEpochMs - right.atEpochMs);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === undefined || last === undefined || last.atEpochMs <= first.atEpochMs) {
        return { outcome: 'too-few-readings', readingCount: ordered.length };
    }
    const spanMs = last.atEpochMs - first.atEpochMs;
    return {
        outcome: 'measured',
        perSecond: toTwoDecimals((last.workPageCount - first.workPageCount) / (spanMs / 1000)),
        readingCount: ordered.length,
        spanMs
    };
}

function computeMedian(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function toTwoDecimals(value: number): number {
    return Math.round(value * 100) / 100;
}
