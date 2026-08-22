import { Reservator } from '@shared/queuebox/DequeueController.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/ResourceInboxAttemptTelemetry.ts';

type AppInboxEvidence = Readonly<{
    commandId: string;
    operationId: string;
    resourceId: string;
    topicId: string;
    contextId: string;
}>;

type RawCommand = Readonly<{
    commandId: string;
    status: 'accepted' | 'exhausted';
}>;

export type AppInboxAttemptObservation = Readonly<{
    commandId: string;
    operationId: string;
    attempt: number;
    outcome: 'accepted' | 'conflicted' | 'transient-retry' | 'exhausted';
    terminal: boolean;
    source: 'resource_inbox.release.telemetry';
    retryDelayMs: number;
    dueAgeMs: number;
    selectedLane: 'fast' | 'fairness' | 'timeout';
    failure: ResourceInboxAttemptReleaseTelemetry['failure'];
}>;

const OPTIMISTIC_CONFLICT_CODES = new Set([
    'app-inbox-reservation-conflict',
    'resource-inbox-lost-reservation',
    'runtime-state-write-conflict',
    'state-snapshot-read-conflict',
    'group-topology-commit-conflict'
]);

const OPTIMISTIC_CONFLICT_NAMES = new Set([
    'RuntimeStateWriteConflictError',
    'CrdtMutationConflictError',
    'StateSnapshotRevisionConflictError',
    'GroupTopologyCommitConflictError',
    'AppInboxReservationConflictError'
]);

export function deriveAppInboxAttemptObservations(
    releases: readonly ResourceInboxAttemptReleaseTelemetry[],
    evidence: readonly AppInboxEvidence[],
    commands: readonly RawCommand[]
): AppInboxAttemptObservation[] {
    const accepted = new Set(
        commands.filter((entry) => entry.status === 'accepted')
            .map((entry) => entry.commandId)
    );
    const evidenceByKey = new Map(evidence.map((entry) => [
        toPhysicalKey(entry),
        entry
    ]));
    return releases.flatMap((release) => {
        const entry = evidenceByKey.get(toPhysicalKey(release.key));
        if (!entry) {
            return [];
        }
        const terminal = release.status !== 'RETRY';
        return [{
            commandId: entry.commandId,
            operationId: entry.operationId,
            attempt: release.attempt,
            outcome: terminal
                ? accepted.has(entry.commandId) ? 'accepted' as const : 'exhausted' as const
                : isOptimisticConflictFailure(release.failure)
                ? 'conflicted' as const
                : 'transient-retry' as const,
            terminal,
            source: 'resource_inbox.release.telemetry' as const,
            retryDelayMs: release.retryDelayMs,
            dueAgeMs: release.dueAgeMs,
            selectedLane: release.selectedLane === Reservator.FAIRNESS
                ? 'fairness' as const
                : release.selectedLane === Reservator.TIMEOUT
                ? 'timeout' as const
                : 'fast' as const,
            failure: release.failure
        }];
    }).toSorted((left, right) =>
        left.commandId.localeCompare(right.commandId) ||
        left.operationId.localeCompare(right.operationId) || left.attempt - right.attempt
    );
}

function toPhysicalKey(
    input: Readonly<{ resourceId: string; topicId: string; contextId: string; }>
): string {
    return [input.resourceId, input.topicId, input.contextId].join('\0');
}

export function isOptimisticConflictFailure(
    failure: ResourceInboxAttemptReleaseTelemetry['failure']
): boolean {
    return failure.kind === 'retryable' &&
        (OPTIMISTIC_CONFLICT_CODES.has(failure.code) ||
            OPTIMISTIC_CONFLICT_NAMES.has(failure.name));
}

export function parseJsonRecord(value: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    }
    catch {
        return undefined;
    }
}

export function readAppInboxCommandType(resource: string): string {
    const payload = parseJsonRecord(resource)?.payload;
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
            typeof (payload as Record<string, unknown>).typeId === 'string'
        ? (payload as Record<string, unknown>).typeId as string
        : 'UNKNOWN';
}

export function parsePersistedResult(value: string | null): unknown {
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value) as unknown;
    }
    catch {
        return null;
    }
}
