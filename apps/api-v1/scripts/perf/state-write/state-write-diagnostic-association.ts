import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    toStateWriteAppInboxExpectations,
    type StateWriteAppInboxExpectation
} from './api-v1-state-write-app-inbox-evidence.ts';
import type { StateWriteDiagnosticPhase } from './state-write-diagnostic-projection.ts';
import type { StateWriteCommandBoundary, StateWriteDiagnosticCommand } from './state-write-workload.ts';

export type StateWriteDiagnosticAssociation =
    | {
        readonly kind: 'process-unassociated';
        readonly reason: 'sql-process-scope' | 'request-unavailable';
        readonly observingStack: number | 'unavailable';
    }
    | {
        readonly kind: 'command-operation';
        readonly commandOrdinal: number;
        readonly operation: string;
        readonly originatingStack: number;
        readonly observingStack: number | 'unavailable';
        readonly attempt: number | 'unavailable';
    };

export interface StateWriteDiagnosticOperation {
    readonly expectation: StateWriteAppInboxExpectation;
    readonly commandOrdinal: number;
    readonly originatingStack: number;
}

export interface StateWriteDiagnosticAssociationIndex {
    readonly requests: ReadonlyMap<string, readonly StateWriteDiagnosticOperation[]>;
    readonly physical: ReadonlyMap<string, readonly StateWriteDiagnosticOperation[]>;
}

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

export function createStateWriteDiagnosticAssociationIndex(
    phase: StateWriteDiagnosticPhase
): StateWriteDiagnosticAssociationIndex {
    const requests = new Map<string, StateWriteDiagnosticOperation[]>();
    const physical = new Map<string, StateWriteDiagnosticOperation[]>();
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

export function toStateWriteTimingAssociation(
    event: RallarTimingEvent,
    index: StateWriteDiagnosticAssociationIndex,
    phase: StateWriteDiagnosticPhase
): StateWriteDiagnosticAssociation | undefined {
    if (!OPERATIONS[event.component]?.includes(event.operation) || !['ok', 'error'].includes(event.status)) {
        return undefined;
    }
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

export function resolveStateWriteReleaseOperation(
    release: ResourceInboxAttemptReleaseTelemetry,
    index: StateWriteDiagnosticAssociationIndex
): StateWriteDiagnosticOperation | undefined {
    const key = JSON.stringify([release.key.resourceId, release.key.topicId, release.key.contextId]);
    const matches = index.physical.get(key);
    if (
        release.type !== 'APP_INBOX' || !Number.isSafeInteger(release.attempt) || release.attempt < 1 ||
        !['accepted', 'not-ready', 'retryable', 'non-retryable'].includes(release.classification) ||
        !Object.values(EntityStatus).includes(release.status) ||
        !Object.values(Reservator).includes(release.selectedLane)
    ) {
        return undefined;
    }
    return matches?.length === 1 ? matches[0] : undefined;
}

export function isStateWriteCommandBoundaryValid(
    command: StateWriteDiagnosticCommand,
    boundary: StateWriteCommandBoundary,
    phase: StateWriteDiagnosticPhase
): boolean {
    const endValid = boundary.endedAtMonotonicMs === 'unavailable'
        ? command.status === 'operation-failed' && phase.outcome === 'operation-failed'
        : isDiagnosticClock(boundary.endedAtMonotonicMs) &&
            boundary.endedAtMonotonicMs >= boundary.startedAtMonotonicMs &&
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
        isDiagnosticClock(boundary.startedAtMonotonicMs) &&
        boundary.startedAtMonotonicMs >= phase.startedAtMonotonicMs &&
        endValid;
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

function isDiagnosticClock(value: number | 'unavailable'): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
