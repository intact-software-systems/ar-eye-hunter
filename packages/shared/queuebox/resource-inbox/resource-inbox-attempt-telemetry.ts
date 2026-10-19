import { Reservator } from '../dequeue/dequeue-controller.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '../ResourceEntry.ts';
import type { ResourceInboxReservationObservation } from './resource-inbox-reservation-observation.ts';

export interface ResourceInboxAttemptTelemetry {
    readonly reservationObservation?: ResourceInboxReservationObservation;
    readonly selectedLane: Reservator;
    readonly queueAgeMs: number;
    readonly dueAgeMs: number;
    readonly attempt: number;
    readonly selectedDueAtEpochMs: number;
    /** How long this claim may stay RESERVED before the TIMEOUT lane reclaims it for another attempt. */
    readonly reservationLeaseMs: number;
    /** When the dequeue clock selected this claim; its lease runs from here, not from when its handler starts. */
    readonly selectedAtEpochMs: number;
}

export interface ResourceInboxAttemptReleaseTelemetry {
    readonly reservationObservation?: ResourceInboxReservationObservation;
    readonly key: Key;
    readonly type: string;
    readonly resource: string;
    readonly attempt: number;
    readonly selectedLane: Reservator;
    readonly queueAgeMs: number;
    readonly dueAgeMs: number;
    readonly classification: 'accepted' | 'not-ready' | 'retryable' | 'non-retryable';
    readonly status: EntityStatus;
    readonly retryDelayMs: number;
    readonly failure:
        | Readonly<{ kind: 'none'; }>
        | ResourceInboxAttemptFailure;
}

/** The failure's code, or its name when it carries none, and the name of the error that caused it. */
export interface ResourceInboxAttemptFailureCause {
    readonly code: string;
    readonly name: string;
}

export interface ResourceInboxAttemptFailure extends ResourceInboxAttemptFailureCause {
    readonly kind: 'retryable' | 'non-retryable';
}

export interface ResourceInboxAttempt {
    readonly entry: ResourceEntry;
    readonly telemetry: ResourceInboxAttemptTelemetry;
}

interface ResourceInboxAttemptInput {
    readonly reservationObservation?: ResourceInboxReservationObservation;
    readonly entry: ResourceEntry;
    readonly selectedLane: Reservator;
    readonly selectedAtEpochMs: number;
    readonly selectedDueAtEpochMs: number | undefined;
    readonly reservationLeaseMs: number;
}

interface ResourceInboxAttemptReleaseInput {
    readonly attempt: ResourceInboxAttempt;
    readonly released: ResourceEntry;
    readonly classification: ResourceInboxAttemptReleaseTelemetry['classification'];
    readonly failure: ResourceInboxAttemptFailureCause | undefined;
}

export function computeResourceInboxAttempt(input: ResourceInboxAttemptInput): ResourceInboxAttempt {
    const { entry, selectedLane, selectedAtEpochMs, selectedDueAtEpochMs, reservationLeaseMs } = input;
    const createdAtEpochMs = Number(entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds);
    const dueAtEpochMs = selectedDueAtEpochMs ?? Number(
        entry.dequeueAudit.nextTs?.epochMilliseconds ?? entry.dequeueAudit.startTs?.epochMilliseconds ??
            selectedAtEpochMs
    );
    return {
        entry,
        telemetry: {
            ...(input.reservationObservation === undefined
                ? {}
                : { reservationObservation: input.reservationObservation }),
            selectedLane,
            queueAgeMs: Math.max(0, selectedAtEpochMs - createdAtEpochMs),
            dueAgeMs: Math.max(0, selectedAtEpochMs - dueAtEpochMs),
            attempt: entry.dequeueAudit.attempts,
            selectedDueAtEpochMs: dueAtEpochMs,
            reservationLeaseMs,
            selectedAtEpochMs
        }
    };
}

export function toResourceInboxAttemptFailureCause(exception: Error): ResourceInboxAttemptFailureCause {
    const code = 'code' in exception && typeof exception.code === 'string' ? exception.code : exception.name;
    return { code, name: exception.name };
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
    const { attempt, released, classification, failure } = input;
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
        ...(selection.reservationObservation === undefined
            ? {}
            : { reservationObservation: selection.reservationObservation }),
        key: reserved.key,
        type: reserved.typeId,
        resource: reserved.resource,
        attempt: classification === 'not-ready' ? released.dequeueAudit.attempts : reserved.dequeueAudit.attempts,
        selectedLane: selection.selectedLane,
        queueAgeMs: selection.queueAgeMs,
        dueAgeMs: selection.dueAgeMs,
        classification,
        status: released.status,
        retryDelayMs,
        failure: classification === 'accepted' || classification === 'not-ready'
            ? { kind: 'none' }
            : toReleaseFailure(classification, failure)
    };
}

function toReleaseFailure(
    classification: Exclude<ResourceInboxAttemptReleaseTelemetry['classification'], 'accepted' | 'not-ready'>,
    failure: ResourceInboxAttemptFailureCause | undefined
): ResourceInboxAttemptFailure {
    if (failure === undefined) {
        throw new Error('Resource inbox failed release telemetry is missing its failure');
    }
    return { kind: classification, ...failure };
}
