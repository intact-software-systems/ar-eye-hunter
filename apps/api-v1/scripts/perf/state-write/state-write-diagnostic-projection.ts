import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { isOptimisticConflictFailure } from '../api-v1-state-write-attempt-evidence.ts';
import {
    toStateWriteAppInboxExpectations,
    type StateWriteAppInboxExpectation
} from './api-v1-state-write-app-inbox-evidence.ts';
import type { StateWriteCommandBoundary, StateWriteDiagnosticCommand } from './state-write-workload.ts';

export interface StateWriteDiagnosticPhase {
    readonly workload: 'uncontended' | 'shared' | 'hot';
    readonly phase: 'warmup' | 'measured';
    readonly runIndex: number;
    readonly scope: StateScope;
    readonly groupCount: number;
    readonly serviceIds: readonly string[];
    readonly performanceTimeOriginEpochMs: number;
    readonly startedAtMonotonicMs: number;
    readonly endedAtMonotonicMs: number | 'unavailable';
    readonly commands: readonly StateWriteDiagnosticCommand[];
    readonly boundaries: readonly StateWriteCommandBoundary[];
    readonly timingEvents: readonly RallarTimingEvent[];
    readonly releases: readonly ResourceInboxAttemptReleaseTelemetry[];
    readonly outcome: 'completed' | 'operation-failed';
}

export interface StateWriteDiagnosticBudget {
    readonly eventsPerPhase: number;
    readonly bytesPerPhase: number;
    readonly bytesPerRun: number;
}

export const STATE_WRITE_DIAGNOSTIC_BUDGET: StateWriteDiagnosticBudget = {
    eventsPerPhase: 100_000,
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

interface DiagnosticOperation {
    readonly expectation: StateWriteAppInboxExpectation;
    readonly commandOrdinal: number;
    readonly originatingStack: number;
}

interface DiagnosticIndex {
    readonly requests: ReadonlyMap<string, readonly DiagnosticOperation[]>;
    readonly physical: ReadonlyMap<string, readonly DiagnosticOperation[]>;
}

type DiagnosticValue = string | number | boolean | DiagnosticRecord | readonly DiagnosticValue[];
interface DiagnosticRecord {
    readonly [key: string]: DiagnosticValue;
}
interface DiagnosticProjectionState {
    readonly lines: string[];
    bytes: number;
    readonly limit: number;
    readonly timing: DiagnosticCounts;
    readonly releases: DiagnosticCounts;
    readonly boundaries: DiagnosticCounts;
}

const FOOTER_RESERVE_BYTES = 768;
const OPERATIONS: Readonly<Record<string, readonly string[]>> = {
    'app-inbox-phase': ['transaction'],
    'app-inbox-handler': [
        'queue-retry',
        'CLIENT_PRINCIPAL_UPSERT',
        'CLIENT_INSTANCE_UPSERT',
        'GROUP_MEMBER_UPSERT',
        'GROUP_PRESENCE_CONNECT',
        'GROUP_PRESENCE_HEARTBEAT',
        'GROUP_PRESENCE_DISCONNECT',
        'GROUP_UPDATE',
        'TOPOLOGY_CONFIG_PUT'
    ],
    'client-state-service': ['mutation.read', 'mutation.compute', 'mutation.validate', 'mutation.write'],
    'group-state-service': [
        'authorizeMutation',
        'captureMutationIngress',
        'captureAppInboxMutationIngress',
        'captureFormationCriterionMutationIngress',
        'captureFormationAutomationMutationIngress',
        'captureTopologyPublicationMutationIngress',
        'captureActivationStatusMutationIngress',
        'captureExpiredPresenceMutationIngresses',
        'captureSessionCleanupMutationIngresses',
        'listSnapshots',
        'listSnapshotsPage',
        'readSnapshot',
        'readCausalRevision',
        'listEvents',
        'listRecentEvents',
        'listEventPage',
        'readIssuedAuthSession',
        'observeSnapshot',
        'read'
    ],
    'state-write-benchmark-sql': ['read', 'write', 'outbox', 'other'],
    'state-write-benchmark-phase': ['transaction']
};

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
        boundaries: createCounts(1 + phase.commands.length)
    };
    const index = createDiagnosticIndex(phase);
    appendDiagnosticRecord(state, toPhaseRecord(phase), state.boundaries);
    appendCommandBoundaries(state, phase);
    for (const release of phase.releases) {
        if (state.releases.retained >= budget.eventsPerPhase) {
            state.releases.truncated += 1;
            continue;
        }
        appendDiagnosticRecord(state, toReleaseRecord(release, index), state.releases);
    }
    for (const event of phase.timingEvents) {
        if (state.timing.retained + state.releases.retained >= budget.eventsPerPhase) {
            state.timing.truncated += 1;
            continue;
        }
        const record = toTimingRecord(event, index, phase);
        appendDiagnosticRecord(state, record, state.timing);
    }
    const complete = phase.outcome === 'completed' && [state.timing, state.releases, state.boundaries]
        .every((counts) => counts.rejected === 0 && counts.truncated === 0);
    const footer = JSON.stringify({
        record: 'completeness',
        complete,
        timing: state.timing,
        releases: state.releases,
        boundaries: state.boundaries
    }) + '\n';
    const footerBytes = new TextEncoder().encode(footer).length;
    if (state.bytes + footerBytes > limit) {
        return { serialized: '', bytes: 0, complete: false };
    }
    return { serialized: state.lines.join('') + footer, bytes: state.bytes + footerBytes, complete };
}

function createCounts(total: number): DiagnosticCounts {
    return { total, retained: 0, unassociated: 0, rejected: 0, truncated: 0 };
}

function createDiagnosticIndex(phase: StateWriteDiagnosticPhase): DiagnosticIndex {
    const requests = new Map<string, DiagnosticOperation[]>();
    const physical = new Map<string, DiagnosticOperation[]>();
    const expectations = toStateWriteAppInboxExpectations(phase.commands, phase.scope, phase.groupCount);
    const commandOrdinals = new Map<string, number>();
    phase.commands.forEach((command, ordinal) => commandOrdinals.set(command.commandId, ordinal));
    for (const expectation of expectations) {
        const commandOrdinal = commandOrdinals.get(expectation.commandId)!;
        const operation = { expectation, commandOrdinal, originatingStack: phase.commands[commandOrdinal]!.stackIndex };
        for (const key of new Set([expectation.logicalResourceId, expectation.physicalKey.resourceId])) {
            requests.set(key, [...(requests.get(key) ?? []), operation]);
        }
        const key = JSON.stringify([
            expectation.physicalKey.resourceId,
            expectation.physicalKey.topicId,
            expectation.physicalKey.contextId
        ]);
        physical.set(key, [...(physical.get(key) ?? []), operation]);
    }
    return { requests, physical };
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
        schema: 'rallar.state-write.diagnostic.v1',
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
        outcome: phase.outcome
    };
}

function appendCommandBoundaries(state: DiagnosticProjectionState, phase: StateWriteDiagnosticPhase): void {
    const boundaries = new Map<string, StateWriteCommandBoundary[]>();
    for (const boundary of phase.boundaries) {
        boundaries.set(boundary.commandId, [...(boundaries.get(boundary.commandId) ?? []), boundary]);
    }
    const seen = new Set<string>();
    const envelopes = new Map<string, { startMs: number; endMs: number; }>();
    phase.commands.forEach((command, commandOrdinal) => {
        const matches = boundaries.get(command.commandId);
        const boundary = matches?.length === 1 ? matches[0] : undefined;
        if (seen.has(command.commandId) || !boundary || !isCommandBoundaryValid(command, boundary, phase)) {
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

function isCommandBoundaryValid(
    command: StateWriteDiagnosticCommand,
    boundary: StateWriteCommandBoundary,
    phase: StateWriteDiagnosticPhase
): boolean {
    const endValid = boundary.endedAtMonotonicMs === 'unavailable'
        ? command.status === 'operation-failed' && phase.outcome === 'operation-failed'
        : isNonnegative(boundary.endedAtMonotonicMs) && boundary.endedAtMonotonicMs >= boundary.startedAtMonotonicMs &&
            (phase.endedAtMonotonicMs === 'unavailable' || boundary.endedAtMonotonicMs <= phase.endedAtMonotonicMs);
    return [
        'profile-instance',
        'membership',
        'presence-connect',
        'presence-heartbeat',
        'presence-disconnect',
        'config',
        'topology-source'
    ].includes(command.kind) &&
        (command.stackIndex === 0 || command.stackIndex === 1) &&
        ['accepted', 'exhausted', 'operation-failed'].includes(command.status) &&
        isNonnegative(boundary.startedAtMonotonicMs) && boundary.startedAtMonotonicMs >= phase.startedAtMonotonicMs &&
        endValid;
}

function toTimingRecord(
    event: RallarTimingEvent,
    index: DiagnosticIndex,
    phase: StateWriteDiagnosticPhase
): DiagnosticRecord | undefined {
    if (
        !OPERATIONS[event.component]?.includes(event.operation) || !['ok', 'error'].includes(event.status) ||
        !isNonnegative(event.durationMs) || !isNonnegative(event.atEpochMs)
    ) {
        return undefined;
    }
    const association = toTimingAssociation(event, index, phase);
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
        approximateStartedAtEpochMs: event.atEpochMs - event.durationMs,
        association,
        queueAgeMs: typeof queueAgeMs === 'number' ? queueAgeMs : 'unavailable',
        dueAgeMs: typeof dueAgeMs === 'number' ? dueAgeMs : 'unavailable',
        statusMeaning: event.component === 'state-write-benchmark-phase'
            ? 'wrapper-finally-not-commit'
            : 'timed-operation-status'
    };
}

function toTimingAssociation(
    event: RallarTimingEvent,
    index: DiagnosticIndex,
    phase: StateWriteDiagnosticPhase
): DiagnosticRecord | undefined {
    const observingStack = event.serviceId === undefined ? 'unavailable' : phase.serviceIds.indexOf(event.serviceId);
    if (
        observingStack === -1 ||
        (event.serviceId !== undefined && phase.serviceIds.filter((id) => id === event.serviceId).length !== 1) ||
        (event.applicationId !== undefined && event.applicationId !== phase.scope.applicationId) ||
        (event.workspaceId !== undefined && event.workspaceId !== phase.scope.workspaceId)
    ) {
        return undefined;
    }
    if (event.requestId === undefined) {
        if (
            event.component === 'app-inbox-phase' || event.component === 'app-inbox-handler' ||
            event.component === 'client-state-service'
        ) {
            return undefined;
        }
        return {
            kind: 'process-unassociated',
            reason: event.component.startsWith('state-write-benchmark-') ? 'sql-process-scope' : 'request-unavailable',
            observingStack
        };
    }
    const matches = index.requests.get(event.requestId);
    const operation = matches?.length === 1 ? matches[0] : undefined;
    if (!operation || !matchesPhysicalDetails(event, operation.expectation)) {
        return undefined;
    }
    if (
        event.component === 'app-inbox-handler' && event.operation !== 'queue-retry' &&
        event.operation !== operation.expectation.topicId
    ) {
        return undefined;
    }
    const attempt = event.details?.attempt;
    if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)) {
        return undefined;
    }
    return {
        kind: 'command-operation',
        commandOrdinal: operation.commandOrdinal,
        operation: operation.expectation.operationId,
        originatingStack: operation.originatingStack,
        observingStack,
        attempt: typeof attempt === 'number' ? attempt : 'unavailable'
    };
}

function matchesPhysicalDetails(event: RallarTimingEvent, expectation: StateWriteAppInboxExpectation): boolean {
    for (const key of ['resourceId', 'topicId', 'contextId'] as const) {
        const value = event.details?.[key];
        if (value !== undefined && value !== expectation.physicalKey[key]) {
            return false;
        }
    }
    return event.details?.type === undefined || event.details.type === expectation.topicId;
}

function toReleaseRecord(
    release: ResourceInboxAttemptReleaseTelemetry,
    index: DiagnosticIndex
): DiagnosticRecord | undefined {
    const key = JSON.stringify([release.key.resourceId, release.key.topicId, release.key.contextId]);
    const matches = index.physical.get(key);
    const operation = matches?.length === 1 ? matches[0] : undefined;
    if (
        !operation || release.type !== 'APP_INBOX' || !Number.isSafeInteger(release.attempt) || release.attempt < 1 ||
        !['accepted', 'not-ready', 'retryable', 'non-retryable'].includes(release.classification) ||
        !Object.values(EntityStatus).includes(release.status) ||
        !isNonnegative(release.queueAgeMs) || !isNonnegative(release.dueAgeMs) ||
        !isNonnegative(release.retryDelayMs) ||
        !Object.values(Reservator).includes(release.selectedLane)
    ) {
        return undefined;
    }
    return {
        record: 'release',
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
): void {
    if (!record) {
        counts.rejected += 1;
        counts.unassociated += 1;
        return;
    }
    const line = JSON.stringify(record) + '\n';
    const bytes = new TextEncoder().encode(line).length;
    if (state.bytes + bytes > state.limit) {
        counts.truncated += 1;
        return;
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
}

function isNonnegative(value: string | number | boolean | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
