import { toErrorSummary } from '../../resilience/to-error.ts';
import type { DequeueController } from '../dequeue/dequeue-controller.ts';
import { toDequeuedKeyText } from '../dequeue/dequeue-lane-flight.ts';
import type * as Resource from '../ResourceEntry.ts';
import {
    EntityStatus,
    isKeysEqual,
    type ResourceEntry
} from '../ResourceEntry.ts';
import type { ResourceInboxAttempt, ResourceInboxAttemptFailureCause } from './resource-inbox-attempt-telemetry.ts';

/**
 * A handler success whose own transaction already committed the terminal entry, so the queue releases nothing and
 * publishes no completion notice: the committer published it.
 */
export class ResourceInboxHandlerFinalizedSuccess {
    readonly entry: ResourceEntry;

    constructor(entry: ResourceEntry) {
        this.entry = entry;
    }
}

/**
 * A handler's typed rejection whose own transaction already committed the terminal entry: a value, not an operational
 * failure. The queue releases nothing, records the attempt as non-retryable and logs the rejection's cause chain.
 */
export class ResourceInboxHandlerFinalizedRejection {
    readonly entry: ResourceEntry;
    readonly code: string;
    readonly cause: Error;

    constructor(entry: ResourceEntry, code: string, cause: Error) {
        this.entry = entry;
        this.code = code;
        this.cause = cause;
    }
}

export type ResourceInboxHandlerFinalized =
    | ResourceInboxHandlerFinalizedSuccess
    | ResourceInboxHandlerFinalizedRejection;

/**
 * A handler's optimistic conflict that committed nothing: a value, not an operational failure. The queue releases the
 * still-reserved entry on the retry path, with its attempt count and backoff, and logs the cause chain once. A conflict
 * whose next attempt recomputes from fresh rows names a short retry delay that caps the backoff, never the attempt
 * budget; null keeps the queue's backoff.
 */
export class ResourceInboxHandlerRetryableConflict {
    readonly entry: ResourceEntry;
    readonly code: string;
    readonly cause: Error;
    readonly retryDelayMs: number | null;

    constructor(entry: ResourceEntry, code: string, cause: Error, retryDelayMs: number | null = null) {
        this.entry = entry;
        this.code = code;
        this.cause = cause;
        this.retryDelayMs = retryDelayMs;
    }
}

export type ResourceInboxHandlerOutcome = ResourceInboxHandlerFinalized | ResourceInboxHandlerRetryableConflict;

export interface ResourceInboxReleasedSuccess<V> {
    readonly original: DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>;
    readonly entry: ResourceEntry;
    readonly classification: 'accepted' | 'non-retryable';
    readonly failure: ResourceInboxAttemptFailureCause | undefined;
}

export function isResourceInboxHandlerFinalized(
    computedValue: unknown
): computedValue is ResourceInboxHandlerFinalized {
    return computedValue instanceof ResourceInboxHandlerFinalizedSuccess ||
        computedValue instanceof ResourceInboxHandlerFinalizedRejection;
}

export function toHandlerFinalizedResourceInboxRelease<V>(
    original: DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>,
    finalized: ResourceInboxHandlerFinalized
): ResourceInboxReleasedSuccess<V> {
    const { entry } = finalized;
    const expectedStatuses: readonly EntityStatus[] = finalized instanceof ResourceInboxHandlerFinalizedSuccess
        ? [EntityStatus.COMPLETED]
        : [EntityStatus.FAILED, EntityStatus.NON_RETRYABLE];
    if (
        !isKeysEqual(entry.key, original.key) ||
        entry.dequeueAudit.attempts !== original.value.entry.dequeueAudit.attempts ||
        !expectedStatuses.includes(entry.status)
    ) {
        throw new Error('Handler-finalized entry does not finalize the claimed reservation');
    }
    if (finalized instanceof ResourceInboxHandlerFinalizedSuccess) {
        return { original, entry, classification: 'accepted', failure: undefined };
    }
    console.error(
        `Handler rejected dequeued key ${toDequeuedKeyText(original.key)} as ${finalized.code}.`,
        toErrorSummary(finalized.cause)
    );
    return {
        original,
        entry,
        classification: 'non-retryable',
        failure: { code: finalized.code, name: finalized.cause.name }
    };
}

export function toReleasedResourceInboxSuccess<V>(
    key: Resource.Key,
    entry: ResourceEntry,
    successes: Map<Resource.Key, DequeueController.Success<Resource.Key, ResourceInboxAttempt, V>>
): ResourceInboxReleasedSuccess<V> {
    const original = [...successes.values()].find((success) => isKeysEqual(success.key, key));
    if (original === undefined || !isKeysEqual(entry.key, key)) {
        throw new Error(`Missing success dto for key: ${String(key)}`);
    }
    return { original, entry, classification: 'accepted', failure: undefined };
}
