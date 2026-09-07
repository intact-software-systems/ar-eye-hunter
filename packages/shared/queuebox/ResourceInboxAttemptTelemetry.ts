import { Reservator } from './DequeueController.ts';
import { EntityStatus, type Key, type ResourceEntry } from './ResourceEntry.ts';

export interface ResourceInboxAttemptTelemetry {
    readonly selectedLane: Reservator;
    readonly queueAgeMs: number;
    readonly dueAgeMs: number;
    readonly attempt: number;
    readonly selectedDueAtEpochMs: number;
}

export interface ResourceInboxAttemptReleaseTelemetry {
    readonly key: Key;
    readonly type: string;
    readonly resource: string;
    readonly attempt: number;
    readonly selectedLane: Reservator;
    readonly queueAgeMs: number;
    readonly dueAgeMs: number;
    readonly classification: 'accepted' | 'retryable' | 'non-retryable';
    readonly status: EntityStatus;
    readonly retryDelayMs: number;
    readonly failure:
        | Readonly<{ kind: 'none'; }>
        | Readonly<{
            kind: 'retryable' | 'non-retryable';
            code: string;
            name: string;
        }>;
}

export interface ResourceInboxAttempt {
    readonly entry: ResourceEntry;
    readonly telemetry: ResourceInboxAttemptTelemetry;
}

interface ResourceInboxAttemptInput {
    readonly entry: ResourceEntry;
    readonly selectedLane: Reservator;
    readonly selectedAtEpochMs: number;
    readonly selectedDueAtEpochMs: number | undefined;
}

interface ResourceInboxAttemptReleaseInput {
    readonly attempt: ResourceInboxAttempt;
    readonly released: ResourceEntry;
    readonly classification: ResourceInboxAttemptReleaseTelemetry['classification'];
    readonly exception: Error | undefined;
}

export function computeResourceInboxAttempt(input: ResourceInboxAttemptInput): ResourceInboxAttempt {
    const { entry, selectedLane, selectedAtEpochMs, selectedDueAtEpochMs } = input;
    const createdAtEpochMs = Number(entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds);
    const dueAtEpochMs = selectedDueAtEpochMs ?? Number(
        entry.dequeueAudit.nextTs?.epochMilliseconds ?? entry.dequeueAudit.startTs?.epochMilliseconds ??
            selectedAtEpochMs
    );
    return {
        entry,
        telemetry: {
            selectedLane,
            queueAgeMs: Math.max(0, selectedAtEpochMs - createdAtEpochMs),
            dueAgeMs: Math.max(0, selectedAtEpochMs - dueAtEpochMs),
            attempt: entry.dequeueAudit.attempts,
            selectedDueAtEpochMs: dueAtEpochMs
        }
    };
}

export function recordResourceInboxAttemptRelease(
    sink: ((event: ResourceInboxAttemptReleaseTelemetry) => void) | undefined,
    input: ResourceInboxAttemptReleaseInput
): void {
    if (!sink) {
        return;
    }
    sink(computeResourceInboxAttemptRelease(input));
}

function computeResourceInboxAttemptRelease(
    input: ResourceInboxAttemptReleaseInput
): ResourceInboxAttemptReleaseTelemetry {
    const { attempt, released, classification, exception } = input;
    const { entry: reserved, telemetry: selection } = attempt;
    const endMs = released.dequeueAudit.endTs
        ? Number(released.dequeueAudit.endTs.epochMilliseconds)
        : undefined;
    const nextMs = released.dequeueAudit.nextTs
        ? Number(released.dequeueAudit.nextTs.epochMilliseconds)
        : undefined;
    const retryDelayMs = endMs !== undefined && nextMs !== undefined ? nextMs - endMs : 0;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
        throw new Error('Persisted resource inbox retry delay is invalid');
    }
    return {
        key: reserved.key,
        type: reserved.typeId,
        resource: reserved.resource,
        attempt: reserved.dequeueAudit.attempts,
        selectedLane: selection.selectedLane,
        queueAgeMs: selection.queueAgeMs,
        dueAgeMs: selection.dueAgeMs,
        classification,
        status: released.status,
        retryDelayMs,
        failure: classification === 'accepted'
            ? { kind: 'none' }
            : toReleaseFailure(classification, exception)
    };
}

function toReleaseFailure(
    classification: Exclude<ResourceInboxAttemptReleaseTelemetry['classification'], 'accepted'>,
    exception: Error | undefined
): Extract<ResourceInboxAttemptReleaseTelemetry['failure'], { kind: 'retryable' | 'non-retryable'; }> {
    if (exception === undefined) {
        throw new Error('Resource inbox failed release telemetry is missing its exception');
    }
    const code = 'code' in exception && typeof exception.code === 'string' ? exception.code : exception.name;
    return { kind: classification, code, name: exception.name };
}
