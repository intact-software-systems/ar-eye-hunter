import { Temporal } from '@js-temporal/polyfill';
import { Either } from '../resilience/Either.ts';
import { toError } from '../resilience/to-error.ts';

import {
    decodeStoredResourceEntryValue,
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import {
    EntityStatus,
    toKeyAsString,
    type ResourceEntry,
    type ResourceEntryKeyString
} from './ResourceEntry.ts';

export type IndexedDbQueueExpectedState =
    | Readonly<{ kind: 'missing'; }>
    | Readonly<{ kind: 'revision'; revision: number; }>;

export interface ComputedIndexedDbQueuePut {
    readonly kind: 'put';
    readonly keyString: ResourceEntryKeyString;
    readonly expected: IndexedDbQueueExpectedState;
    readonly value: StoredResourceEntry;
}

interface ComputedIndexedDbQueueDelete {
    readonly kind: 'delete';
    readonly keyString: ResourceEntryKeyString;
    readonly expected: IndexedDbQueueExpectedState;
}

export interface ComputedIndexedDbQueueGuard {
    readonly kind: 'guard';
    readonly keyString: ResourceEntryKeyString;
    readonly expected: IndexedDbQueueExpectedState;
}

interface ComputedIndexedDbQueueUnconditionalDelete {
    readonly kind: 'delete-unconditionally';
    readonly keyString: ResourceEntryKeyString;
}

interface ComputedIndexedDbQueueUnconditionalPut {
    readonly kind: 'put-unconditionally';
    readonly keyString: ResourceEntryKeyString;
    readonly value: StoredResourceEntry;
}

export type ComputedIndexedDbQueueMutation =
    | ComputedIndexedDbQueuePut
    | ComputedIndexedDbQueueGuard
    | ComputedIndexedDbQueueDelete
    | ComputedIndexedDbQueueUnconditionalDelete
    | ComputedIndexedDbQueueUnconditionalPut;

export function computeIndexedDbQueuePut(
    stored: StoredResourceEntry | undefined,
    entry: ResourceEntry
): ComputedIndexedDbQueuePut {
    const expected = toIndexedDbQueueExpectedState(stored);
    const nextRevision = stored ? stored.revision + 1 : 0;
    return {
        kind: 'put',
        keyString: toKeyAsString(entry.key),
        expected,
        value: encodeStoredResourceEntry(entry, nextRevision)
    };
}

export function computeIndexedDbQueueDelete(
    stored: StoredResourceEntry
): ComputedIndexedDbQueueDelete {
    return {
        kind: 'delete',
        keyString: stored.keyString,
        expected: toIndexedDbQueueExpectedState(stored)
    };
}

export function computeIndexedDbQueueGuard(
    keyString: ResourceEntryKeyString,
    stored: StoredResourceEntry | undefined
): ComputedIndexedDbQueueGuard {
    return { kind: 'guard', keyString, expected: toIndexedDbQueueExpectedState(stored) };
}

export function computeIndexedDbQueueUnconditionalDelete(
    keyString: ResourceEntryKeyString
): ComputedIndexedDbQueueUnconditionalDelete {
    return { kind: 'delete-unconditionally', keyString };
}

/** A row written whole by its only writer, which never reads it first: it restarts at revision 0. */
export function computeIndexedDbQueueUnconditionalPut(entry: ResourceEntry): ComputedIndexedDbQueueUnconditionalPut {
    return {
        kind: 'put-unconditionally',
        keyString: toKeyAsString(entry.key),
        value: encodeStoredResourceEntry(entry, 0)
    };
}

export function validateComputedIndexedDbQueueMutations(
    mutations: readonly ComputedIndexedDbQueueMutation[]
): Either<Error, readonly ComputedIndexedDbQueueMutation[]> {
    try {
        const keys = new Set<string>();
        for (const mutation of mutations) {
            if (
                mutation.kind !== 'put' && mutation.kind !== 'delete' && mutation.kind !== 'guard' &&
                mutation.kind !== 'delete-unconditionally' && mutation.kind !== 'put-unconditionally'
            ) {
                return Either.ofLeft(new TypeError('IndexedDB queue mutation kind is unsupported'));
            }
            if (typeof mutation.keyString !== 'string') {
                return Either.ofLeft(new TypeError('IndexedDB queue mutation key must be a string'));
            }
            if (keys.has(mutation.keyString)) {
                return Either.ofLeft(new TypeError('IndexedDB mutations contain a duplicate queue key'));
            }
            keys.add(mutation.keyString);
            if (mutation.kind === 'delete-unconditionally') {
                continue;
            }
            if (mutation.kind === 'put-unconditionally') {
                const issue = validateStoredQueueValue(mutation);
                if (issue) {
                    return Either.ofLeft(issue);
                }
                continue;
            }
            if (!isValidIndexedDbQueueExpectedState(mutation.expected)) {
                return Either.ofLeft(
                    new TypeError('IndexedDB queue expected state must be missing or a non-negative revision')
                );
            }
            if (mutation.kind === 'guard') {
                continue;
            }
            if (mutation.kind === 'delete') {
                if (mutation.expected.kind === 'missing') {
                    return Either.ofLeft(new TypeError('IndexedDB queue delete cannot expect a missing row'));
                }
                continue;
            }
            const issue = validateStoredQueueValue(mutation);
            if (issue) {
                return Either.ofLeft(issue);
            }
            const expectedRevision = mutation.expected.kind === 'missing'
                ? 0
                : mutation.expected.revision + 1;
            if (mutation.value.revision !== expectedRevision) {
                return Either.ofLeft(new TypeError('IndexedDB queue mutation revision is not the next revision'));
            }
        }
        return Either.ofRight(mutations);
    }
    catch (error) {
        return Either.ofLeft(toError(error));
    }
}

function validateStoredQueueValue(
    mutation: ComputedIndexedDbQueuePut | ComputedIndexedDbQueueUnconditionalPut
): TypeError | undefined {
    decodeStoredResourceEntryValue(mutation.value);
    return mutation.value.keyString === mutation.keyString
        ? undefined
        : new TypeError('IndexedDB queue mutation key differs from its stored value');
}

export function computeReservedQueueEntry(
    entry: ResourceEntry,
    now: Temporal.Instant
): ResourceEntry {
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            startTs: now,
            endTs: undefined,
            nextTs: undefined,
            attempts: entry.dequeueAudit.attempts + 1
        }
    };
}

export function isStoredQueueEntryExpired(
    stored: StoredResourceEntry,
    now: Temporal.Instant
): boolean {
    return isAtOrAfterStoredInstant(now, stored.expiryEpochMs, stored.audit.expiryTs);
}

interface StoredQueueEntryReservationInput {
    readonly stored: StoredResourceEntry;
    readonly typeIds: ReadonlySet<string>;
    readonly statusIds: ReadonlySet<EntityStatus>;
    readonly now: Temporal.Instant;
    readonly maxAttempts: number;
}

export function isStoredQueueEntryReservable(input: StoredQueueEntryReservationInput): boolean {
    const { stored, typeIds, statusIds, now, maxAttempts } = input;
    if (isStoredQueueEntryExpired(stored, now)) {
        return false;
    }
    if (!typeIds.has(stored.typeId) || !statusIds.has(stored.status)) {
        return false;
    }
    if (stored.status === EntityStatus.FAILED || stored.dequeueAudit.attempts >= maxAttempts) {
        return false;
    }
    return !stored.dequeueAudit.nextTs ||
        isAtOrAfterStoredInstant(now, stored.fairnessDueEpochMs, stored.dequeueAudit.nextTs);
}

interface StoredQueueEntryTimeoutInput {
    readonly stored: StoredResourceEntry;
    readonly typeIds: ReadonlySet<string>;
    readonly duration: Temporal.Duration;
    readonly now: Temporal.Instant;
}

export function isStoredQueueEntryTimedOut(input: StoredQueueEntryTimeoutInput): boolean {
    const { stored, typeIds, duration, now } = input;
    if (
        isStoredQueueEntryExpired(stored, now) ||
        !typeIds.has(stored.typeId) ||
        stored.status !== EntityStatus.RESERVED ||
        !stored.dequeueAudit.startTs
    ) {
        return false;
    }
    const startTs = Temporal.Instant.from(stored.dequeueAudit.startTs);
    return Temporal.Instant.compare(now, startTs.add(duration)) >= 0;
}

/** An epoch-ms mirror is its instant floored to the millisecond, so only a tie needs the instant itself. */
function isAtOrAfterStoredInstant(
    now: Temporal.Instant,
    epochMs: number | undefined,
    instant: string
): boolean {
    const nowMs = Number(now.epochMilliseconds);
    if (epochMs === undefined || nowMs === epochMs) {
        return Temporal.Instant.compare(now, Temporal.Instant.from(instant)) >= 0;
    }
    return nowMs > epochMs;
}

function toIndexedDbQueueExpectedState(
    stored: StoredResourceEntry | undefined
): IndexedDbQueueExpectedState {
    if (!stored) {
        return { kind: 'missing' };
    }
    const canonical = decodeStoredResourceEntryValue(stored);
    return { kind: 'revision', revision: canonical.revision };
}

function isValidIndexedDbQueueExpectedState(expected: IndexedDbQueueExpectedState): boolean {
    return expected.kind === 'missing' ||
        (expected.kind === 'revision' && Number.isSafeInteger(expected.revision) && expected.revision >= 0 &&
            !Object.is(expected.revision, -0));
}
