import { Temporal } from '@js-temporal/polyfill';

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

export interface ComputedIndexedDbQueueDelete {
    readonly kind: 'delete';
    readonly keyString: ResourceEntryKeyString;
    readonly expected: IndexedDbQueueExpectedState;
}

export interface ComputedIndexedDbQueueUnconditionalDelete {
    readonly kind: 'delete-unconditionally';
    readonly keyString: ResourceEntryKeyString;
}

export type ComputedIndexedDbQueueMutation =
    | ComputedIndexedDbQueuePut
    | ComputedIndexedDbQueueDelete
    | ComputedIndexedDbQueueUnconditionalDelete;

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

export function computeIndexedDbQueueUnconditionalDelete(
    keyString: ResourceEntryKeyString
): ComputedIndexedDbQueueUnconditionalDelete {
    return { kind: 'delete-unconditionally', keyString };
}

export function validateComputedIndexedDbQueueMutations(
    mutations: readonly ComputedIndexedDbQueueMutation[]
): void {
    for (const mutation of mutations) {
        if (typeof mutation.keyString !== 'string') {
            throw new TypeError('IndexedDB queue mutation key must be a string');
        }
        if (mutation.kind === 'delete-unconditionally') {
            continue;
        }
        validateIndexedDbQueueExpectedState(mutation.expected);
        if (mutation.kind === 'delete') {
            if (mutation.expected.kind === 'missing') {
                throw new TypeError('IndexedDB queue delete cannot expect a missing row');
            }
            continue;
        }
        decodeStoredResourceEntryValue(mutation.value);
        if (mutation.value.keyString !== mutation.keyString) {
            throw new TypeError('IndexedDB queue mutation key differs from its stored value');
        }
        const expectedRevision = mutation.expected.kind === 'missing'
            ? 0
            : mutation.expected.revision + 1;
        if (mutation.value.revision !== expectedRevision) {
            throw new TypeError('IndexedDB queue mutation revision is not the next revision');
        }
    }
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
    return Temporal.Instant.compare(now, Temporal.Instant.from(stored.audit.expiryTs)) >= 0;
}

export function isStoredQueueEntryReservable(
    input: Readonly<{
        stored: StoredResourceEntry;
        typeIds: ReadonlySet<string>;
        statusIds: ReadonlySet<EntityStatus>;
        now: Temporal.Instant;
        maxAttempts: number;
    }>
): boolean {
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
        Temporal.Instant.compare(now, Temporal.Instant.from(stored.dequeueAudit.nextTs)) >= 0;
}

export function isStoredQueueEntryTimedOut(
    input: Readonly<{
        stored: StoredResourceEntry;
        typeIds: ReadonlySet<string>;
        duration: Temporal.Duration;
        now: Temporal.Instant;
    }>
): boolean {
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

function toIndexedDbQueueExpectedState(
    stored: StoredResourceEntry | undefined
): IndexedDbQueueExpectedState {
    if (!stored) {
        return { kind: 'missing' };
    }
    const canonical = decodeStoredResourceEntryValue(stored);
    return { kind: 'revision', revision: canonical.revision };
}

function validateIndexedDbQueueExpectedState(expected: IndexedDbQueueExpectedState): void {
    if (expected.kind === 'missing') {
        return;
    }
    if (
        !Number.isSafeInteger(expected.revision) ||
        expected.revision < 0 ||
        Object.is(expected.revision, -0)
    ) {
        throw new TypeError('IndexedDB queue expected revision must be non-negative');
    }
}
