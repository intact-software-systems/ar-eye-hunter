import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { validateResourceInboxReservationObservation } from '@shared/queuebox/resource-inbox/resource-inbox-reservation-observation.ts';
import { isKeysEqual } from '@shared/queuebox/ResourceEntry.ts';

import { isOptimisticConflictFailure } from '../api-v1-state-write-attempt-evidence.ts';
import type { StateWriteBenchmarkPhaseFacts } from './state-write-benchmark-diagnostics.ts';
import {
    createStateWriteDiagnosticAssociationIndex,
    isStateWriteCommandBoundaryValid,
    resolveStateWriteReleaseOperation,
    toStateWriteTimingAssociation,
    type StateWriteDiagnosticAssociationIndex
} from './state-write-diagnostic-association.ts';
import type { StateWriteCommandBoundary } from './state-write-workload.ts';

export interface StateWriteDiagnosticPhase extends StateWriteBenchmarkPhaseFacts {
    readonly releases: readonly ResourceInboxAttemptReleaseTelemetry[];
}

export interface StateWriteDiagnosticBudget {
    readonly eventsPerPhase: number;
    readonly bytesPerPhase: number;
    readonly bytesPerRun: number;
}

export const STATE_WRITE_DIAGNOSTIC_BUDGET: StateWriteDiagnosticBudget = {
    eventsPerPhase: 110_000,
    bytesPerPhase: 33_554_432,
    bytesPerRun: 536_870_912
};

export interface StateWriteDiagnosticProjection {
    readonly serialized: string;
    readonly bytes: number;
    readonly complete: boolean;
}

interface DiagnosticCounts {
    total: number;
    retained: number;
    unassociated: number;
    rejected: number;
    truncated: number;
}

type DiagnosticValue = string | number | boolean | DiagnosticRecord | readonly DiagnosticValue[];
interface DiagnosticRecord {
    readonly [key: string]: DiagnosticValue;
}
interface DiagnosticReleaseRecord extends DiagnosticRecord {
    readonly reservationObservation: DiagnosticRecord;
}

interface DiagnosticKindEnvelope {
    readonly startMs: number;
    readonly endMs: number;
}

interface DiagnosticProjectionState {
    readonly lines: string[];
    bytes: number;
    readonly limit: number;
    readonly timing: DiagnosticCounts;
    readonly releases: DiagnosticCounts;
    readonly boundaries: DiagnosticCounts;
    readonly reservationObservations: { expected: number; available: number; unavailable: number; };
}

const FOOTER_RESERVE_BYTES = 768;

export function computeStateWriteDiagnosticPhase(
    phase: StateWriteDiagnosticPhase,
    budget: StateWriteDiagnosticBudget,
    remainingRunBytes: number
): StateWriteDiagnosticProjection {
    const limit = Math.max(0, Math.min(budget.bytesPerPhase, remainingRunBytes));
    const state: DiagnosticProjectionState = {
        lines: [],
        bytes: 0,
        limit: Math.max(0, limit - FOOTER_RESERVE_BYTES),
        timing: createCounts(phase.timingEvents.length),
        releases: createCounts(phase.releases.length),
        boundaries: createCounts(1 + phase.commands.length),
        reservationObservations: { expected: 0, available: 0, unavailable: 0 }
    };
    const index = createStateWriteDiagnosticAssociationIndex(phase);
    appendDiagnosticRecord(state, toPhaseRecord(phase), state.boundaries);
    appendCommandBoundaries(state, phase);
    appendReleaseRecords(state, { releases: phase.releases, index, eventsPerPhase: budget.eventsPerPhase });
    for (const event of phase.timingEvents) {
        if (state.timing.retained + state.releases.retained >= budget.eventsPerPhase) {
            state.timing.truncated += 1;
            continue;
        }
        const record = toTimingRecord(event, index, phase);
        appendDiagnosticRecord(state, record, state.timing);
    }
    const complete = state.reservationObservations.unavailable === 0 && phase.outcome === 'completed' &&
        [state.timing, state.releases, state.boundaries]
            .every((counts) => counts.rejected === 0 && counts.truncated === 0);
    const footer = JSON.stringify({
        record: 'completeness',
        complete,
        timing: state.timing,
        releases: state.releases,
        boundaries: state.boundaries,
        reservationObservations: state.reservationObservations
    }) + '\n';
    const footerBytes = new TextEncoder().encode(footer).length;
    if (state.bytes + footerBytes > limit) {
        return { serialized: '', bytes: 0, complete: false };
    }
    return { serialized: state.lines.join('') + footer, bytes: state.bytes + footerBytes, complete };
}

interface DiagnosticReleaseProjection {
    readonly releases: readonly ResourceInboxAttemptReleaseTelemetry[];
    readonly index: StateWriteDiagnosticAssociationIndex;
    readonly eventsPerPhase: number;
}

function appendReleaseRecords(
    state: DiagnosticProjectionState,
    { releases, index, eventsPerPhase }: DiagnosticReleaseProjection
): void {
    for (const release of releases) {
        let record: DiagnosticReleaseRecord | undefined;
        let retained = false;
        if (state.releases.retained >= eventsPerPhase) {
            state.releases.truncated += 1;
        }
        else {
            record = toReleaseRecord(release, index);
            retained = appendDiagnosticRecord(state, record, state.releases);
        }

        if (release.selectedLane !== 'RETRY') {
            continue;
        }
        state.reservationObservations.expected += 1;
        if (retained && record?.reservationObservation.availability === 'available') {
            state.reservationObservations.available += 1;
        }
        else {
            state.reservationObservations.unavailable += 1;
        }
    }
}

function createCounts(total: number): DiagnosticCounts {
    return { total, retained: 0, unassociated: 0, rejected: 0, truncated: 0 };
}

function toPhaseRecord(phase: StateWriteDiagnosticPhase): DiagnosticRecord | undefined {
    if (
        !['uncontended', 'shared', 'hot'].includes(phase.workload) || !['warmup', 'measured'].includes(phase.phase) ||
        !isNonnegative(phase.runIndex) || !isNonnegative(phase.performanceTimeOriginEpochMs) ||
        !isNonnegative(phase.startedAtMonotonicMs) ||
        (phase.endedAtMonotonicMs !== 'unavailable' &&
            (phase.endedAtMonotonicMs < phase.startedAtMonotonicMs || !isNonnegative(phase.endedAtMonotonicMs)))
    ) {
        return undefined;
    }
    return {
        record: 'phase',
        schema: 'rallar.state-write.diagnostic.v3',
        workload: phase.workload,
        phase: phase.phase,
        runIndex: phase.runIndex,
        performanceTimeOriginEpochMs: phase.performanceTimeOriginEpochMs,
        startedAtMonotonicMs: phase.startedAtMonotonicMs,
        endedAtMonotonicMs: phase.endedAtMonotonicMs,
        nativeProfilerAlignment: 'unavailable',
        eventStart: 'approximate-completion-minus-rounded-duration',
        exactKindEndpoints: 'unavailable',
        selectedDueTimestamp: 'unavailable',
        reservationObservationBoundary: 'postgres-update-returning',
        reservationObservationLimits: [
            'ordinary-unobserved-postgres-retry-only',
            'pre-commit-not-lock-or-handler-time',
            'microsecond-quantization',
            'database-wall-clock-adjustments',
            'FAIRNESS',
            'TIMEOUT',
            'FINALIZATION'
        ],
        outcome: phase.outcome
    };
}

function appendCommandBoundaries(state: DiagnosticProjectionState, phase: StateWriteDiagnosticPhase): void {
    const boundaries = new Map<string, StateWriteCommandBoundary[]>();
    for (const boundary of phase.boundaries) {
        boundaries.set(boundary.commandId, [...(boundaries.get(boundary.commandId) ?? []), boundary]);
    }
    const seen = new Set<string>();
    const envelopes = new Map<string, DiagnosticKindEnvelope>();
    phase.commands.forEach((command, commandOrdinal) => {
        const matches = boundaries.get(command.commandId);
        const boundary = matches?.length === 1 ? matches[0] : undefined;
        if (seen.has(command.commandId) || !boundary || !isStateWriteCommandBoundaryValid(command, boundary, phase)) {
            state.boundaries.rejected += 1;
            return;
        }
        seen.add(command.commandId);
        appendDiagnosticRecord(state, {
            record: 'command',
            commandOrdinal,
            kind: command.kind,
            originatingStack: command.stackIndex,
            startedAtMonotonicMs: boundary.startedAtMonotonicMs,
            endedAtMonotonicMs: boundary.endedAtMonotonicMs,
            status: command.status
        }, state.boundaries);
        if (boundary.endedAtMonotonicMs === 'unavailable') {
            return;
        }
        const envelope = envelopes.get(command.kind);
        envelopes.set(command.kind, {
            startMs: Math.min(envelope?.startMs ?? Infinity, boundary.startedAtMonotonicMs),
            endMs: Math.max(envelope?.endMs ?? -Infinity, boundary.endedAtMonotonicMs)
        });
    });
    for (const [kind, envelope] of envelopes) {
        state.boundaries.total += 1;
        appendDiagnosticRecord(
            state,
            { record: 'kind', kind, ...envelope, clock: 'derived-command-envelope' },
            state.boundaries
        );
    }
    const unmatched = phase.boundaries.filter((boundary) => !seen.has(boundary.commandId)).length;
    state.boundaries.total += unmatched;
    state.boundaries.rejected += unmatched;
}

function toTimingRecord(
    event: RallarTimingEvent,
    index: StateWriteDiagnosticAssociationIndex,
    phase: StateWriteDiagnosticPhase
): DiagnosticRecord | undefined {
    if (!isNonnegative(event.durationMs) || !isNonnegative(event.atEpochMs)) {
        return undefined;
    }
    const association = toStateWriteTimingAssociation(event, index, phase);
    if (!association) {
        return undefined;
    }
    const queueAgeMs = event.details?.queueAgeMs;
    const dueAgeMs = event.details?.dueAgeMs;
    if (
        (queueAgeMs !== undefined && !isNonnegative(queueAgeMs)) || (dueAgeMs !== undefined && !isNonnegative(dueAgeMs))
    ) {
        return undefined;
    }
    return {
        record: 'timing',
        component: event.component,
        operation: event.operation,
        status: event.status,
        completedAtEpochMs: event.atEpochMs,
        roundedDurationMs: event.durationMs,
        association,
        queueAgeMs: typeof queueAgeMs === 'number' ? queueAgeMs : 'unavailable',
        dueAgeMs: typeof dueAgeMs === 'number' ? dueAgeMs : 'unavailable'
    };
}

function toReleaseRecord(
    release: ResourceInboxAttemptReleaseTelemetry,
    index: StateWriteDiagnosticAssociationIndex
): DiagnosticReleaseRecord | undefined {
    const operation = resolveStateWriteReleaseOperation(release, index);
    if (
        !operation ||
        !isNonnegative(release.queueAgeMs) || !isNonnegative(release.dueAgeMs) ||
        !isNonnegative(release.retryDelayMs)
    ) {
        return undefined;
    }
    const reservationObservation = toReservationObservationRecord(release);
    if (!reservationObservation) {
        return undefined;
    }
    return {
        record: 'release',
        reservationObservation,
        commandOrdinal: operation.commandOrdinal,
        operation: operation.expectation.operationId,
        originatingStack: operation.originatingStack,
        observingStack: 'unavailable',
        endpoint: 'unavailable',
        attempt: release.attempt,
        classification: release.classification,
        status: release.status,
        selectedLane: release.selectedLane,
        queueAgeMs: release.queueAgeMs,
        dueAgeMs: release.dueAgeMs,
        retryDelayMs: release.retryDelayMs,
        failure: release.failure.kind === 'none'
            ? 'none'
            : isOptimisticConflictFailure(release.failure)
            ? 'optimistic-conflict'
            : release.failure.kind === 'retryable'
            ? 'transient-retry'
            : 'non-retryable'
    };
}

function appendDiagnosticRecord(
    state: DiagnosticProjectionState,
    record: DiagnosticRecord | undefined,
    counts: DiagnosticCounts
): boolean {
    if (!record) {
        counts.rejected += 1;
        counts.unassociated += 1;
        return false;
    }
    const line = JSON.stringify(record) + '\n';
    const bytes = new TextEncoder().encode(line).length;
    if (state.bytes + bytes > state.limit) {
        counts.truncated += 1;
        return false;
    }
    state.lines.push(line);
    state.bytes += bytes;
    counts.retained += 1;
    const association = record.association;
    if (
        typeof association === 'object' && !Array.isArray(association) && 'kind' in association &&
        association.kind === 'process-unassociated'
    ) {
        counts.unassociated += 1;
    }
    return true;
}

function isNonnegative(value: string | number | boolean | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toReservationObservationRecord(release: ResourceInboxAttemptReleaseTelemetry): DiagnosticRecord | undefined {
    const reservationAttempt = release.attempt + (release.classification === 'not-ready' ? 1 : 0);
    const unavailable = {
        availability: 'unavailable',
        boundary: 'unavailable',
        association: 'unavailable',
        reservationAttempt
    };
    if (release.selectedLane !== 'RETRY') {
        if (release.reservationObservation !== undefined) {
            return undefined;
        }
        return { ...unavailable, reason: release.selectedLane === 'NEW' ? 'not-applicable' : 'lane-not-captured' };
    }
    const observation = release.reservationObservation;
    if (
        !observation || validateResourceInboxReservationObservation(observation).length > 0 ||
        !isKeysEqual(release.key, observation.key) || observation.reservationAttempt !== reservationAttempt
    ) {
        return { ...unavailable, reason: 'invalid-observation' };
    }
    if (observation.availability === 'unavailable') {
        return { ...unavailable, reason: observation.reason };
    }
    return {
        availability: observation.availability,
        boundary: observation.boundary,
        association: observation.association,
        reservationAttempt,
        previousPersistedRetryDelayUs: observation.previousPersistedRetryDelayUs,
        dueToReservationObservationUs: observation.dueToReservationObservationUs
    };
}
