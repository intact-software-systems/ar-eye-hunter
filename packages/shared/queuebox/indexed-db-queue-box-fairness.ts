import { Temporal } from '@js-temporal/polyfill';
import {
    computeIndexedDbQueuePut,
    computeReservedQueueEntry,
    decodeStoredResourceEntry,
    isStoredQueueEntryExpired,
    type ComputedIndexedDbQueueMutation,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry.ts';
import type { ResourceInboxFairnessSelection } from './queue-box-types.ts';
import type { Key } from './ResourceEntry.ts';

export type ComputeIndexedDbFairnessReservationInput = Readonly<{
    entriesByType: ReadonlyMap<string, readonly StoredResourceEntry[]>;
    maxAttempts: number;
    maxToReserve: number;
    maxToScan: number;
    now: Temporal.Instant;
    requestedTypes: readonly string[];
}>;

export type ComputedIndexedDbFairnessReservation = Readonly<{
    mutations: readonly ComputedIndexedDbQueueMutation[];
    result: Map<Key, ResourceInboxFairnessSelection>;
}>;

export function computeIndexedDbFairnessReservation(
    input: ComputeIndexedDbFairnessReservationInput
): ComputedIndexedDbFairnessReservation {
    const states = input.requestedTypes.map((typeId) => ({
        entries: input.entriesByType.get(typeId) ?? [],
        offset: 0
    }));
    const result = new Map<Key, ResourceInboxFairnessSelection>();
    const mutations: ComputedIndexedDbQueueMutation[] = [];
    let scanned = states.length;

    while (result.size < input.maxToReserve) {
        const available = states.filter((state) => state.offset < state.entries.length);
        if (available.length === 0) {
            break;
        }
        const selectedState = available.reduce(earlierFairnessState);
        const stored = selectedState.entries[selectedState.offset];
        if (
            !isStoredQueueEntryExpired(stored, input.now) &&
            stored.dequeueAudit.attempts < input.maxAttempts
        ) {
            const selectedDueTs = Temporal.Instant.from(stored.dequeueAudit.nextTs!);
            const entry = computeReservedQueueEntry(decodeStoredResourceEntry(stored), input.now);
            result.set(entry.key, { entry, selectedDueTs });
            mutations.push(computeIndexedDbQueuePut(stored, entry));
        }
        if (result.size >= input.maxToReserve || scanned >= input.maxToScan) {
            selectedState.offset = selectedState.entries.length;
            continue;
        }
        scanned += 1;
        selectedState.offset += 1;
    }
    return { mutations, result };
}

interface FairnessState {
    readonly entries: readonly StoredResourceEntry[];
    offset: number;
}

function earlierFairnessState(left: FairnessState, right: FairnessState): FairnessState {
    const leftEntry = left.entries[left.offset];
    const rightEntry = right.entries[right.offset];
    const dueOrder = leftEntry.fairnessDueEpochMs! - rightEntry.fairnessDueEpochMs!;
    if (dueOrder !== 0) {
        return dueOrder < 0 ? left : right;
    }
    return leftEntry.keyString <= rightEntry.keyString ? left : right;
}
