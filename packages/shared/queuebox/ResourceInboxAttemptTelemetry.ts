import { Reservator } from './DequeueController.ts';
import { EntityStatus, type Key, type ResourceEntry } from './ResourceEntry.ts';

export type ResourceInboxAttemptTelemetry = Readonly<{
    selectedLane: Reservator;
    queueAgeMs: number;
    dueAgeMs: number;
    attempt: number;
    selectedDueAtEpochMs: number;
}>;

export type ResourceInboxAttemptReleaseTelemetry = Readonly<{
    key: Key;
    type: string;
    resource: string;
    attempt: number;
    selectedLane: Reservator;
    queueAgeMs: number;
    dueAgeMs: number;
    classification: 'accepted' | 'retryable' | 'non-retryable';
    status: EntityStatus;
    retryDelayMs: number;
    failure:
        | Readonly<{ kind: 'none' }>
        | Readonly<{
            kind: 'retryable' | 'non-retryable';
            code: string;
            name: string;
        }>;
}>;

const attempts = new WeakMap<ResourceEntry, ResourceInboxAttemptTelemetry>();

export function rememberResourceInboxAttemptTelemetry(
    entry: ResourceEntry,
    selectedLane: Reservator,
    selectedAtEpochMs: number,
    selectedDueAtEpochMs?: number,
): void {
    const createdAtEpochMs = Number(entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds);
    const dueAtEpochMs = selectedDueAtEpochMs ?? Number(
        entry.dequeueAudit.nextTs?.epochMilliseconds ??
        entry.dequeueAudit.startTs?.epochMilliseconds ??
        selectedAtEpochMs,
    );
    attempts.set(entry, {
        selectedLane,
        queueAgeMs: Math.max(0, selectedAtEpochMs - createdAtEpochMs),
        dueAgeMs: Math.max(0, selectedAtEpochMs - dueAtEpochMs),
        attempt: entry.dequeueAudit.attempts,
        selectedDueAtEpochMs: dueAtEpochMs,
    });
}

export function readResourceInboxAttemptTelemetry(
    entry: ResourceEntry,
): ResourceInboxAttemptTelemetry | undefined {
    return attempts.get(entry);
}

export function recordResourceInboxAttemptRelease(
    sink: ((event: ResourceInboxAttemptReleaseTelemetry) => void) | undefined,
    reserved: ResourceEntry,
    released: ResourceEntry,
    classification: ResourceInboxAttemptReleaseTelemetry['classification'],
    exception?: unknown,
): void {
    if (!sink) return;
    const selection = readResourceInboxAttemptTelemetry(reserved);
    if (!selection) throw new Error('Resource inbox attempt selection telemetry is missing');
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
    if (classification !== 'accepted' && exception === undefined) {
        throw new Error('Resource inbox failed release telemetry is missing its exception');
    }
    sink({
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
            : toReleaseFailure(classification, exception),
    });
}

function toReleaseFailure(
    classification: Exclude<
        ResourceInboxAttemptReleaseTelemetry['classification'],
        'accepted'
    >,
    exception: unknown,
): Extract<
    ResourceInboxAttemptReleaseTelemetry['failure'],
    { kind: 'retryable' | 'non-retryable' }
> {
    const error = exception instanceof Error ? exception : new Error(String(exception));
    const code = typeof exception === 'object' && exception !== null && 'code' in exception &&
            typeof exception.code === 'string'
        ? exception.code
        : error.name;
    return { kind: classification, code, name: error.name };
}
