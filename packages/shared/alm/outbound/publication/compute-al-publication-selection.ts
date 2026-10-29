import type { ALPublicationDrainBudget } from '../../../al-contracts/publication/al-publication-policy.ts';

export interface ALPublicationSelectionCandidate {
    readonly bytes: number;
    readonly expiresAtMs: number;
}

export interface ComputeALPublicationSelectionInput<T extends ALPublicationSelectionCandidate> {
    /** The lane's streams in their first-staged order, each oldest first. */
    readonly streams: readonly (readonly T[])[];
    readonly drain: ALPublicationDrainBudget;
    readonly nowMs: number;
    /** The lane's cursor: the index of the stream this opportunity serves first (D478). */
    readonly startIndex: number;
}

export interface ALPublicationSelection<T extends ALPublicationSelectionCandidate> {
    readonly selected: readonly T[];
    readonly expired: readonly T[];
    /** Aligned with the input streams by index: what each still holds for a later opportunity. */
    readonly remaining: readonly (readonly T[])[];
    /** The index of the stream after the last one served, wrapping to 0; 0 when none was served. */
    readonly nextStartIndex: number;
}

/**
 * Expired values leave first and spend no budget; the rest are taken stream by stream from `startIndex`, wrapping,
 * each stream oldest first, until the next value would pass the message or byte budget, and everything after it
 * waits (D469, D478).
 */
export function computeALPublicationSelection<T extends ALPublicationSelectionCandidate>(
    input: ComputeALPublicationSelectionInput<T>
): ALPublicationSelection<T> {
    const live = input.streams.map((stream) => stream.filter((value) => input.nowMs < value.expiresAtMs));
    const rotation = computeRotation(live.length, input.startIndex);
    const ordered = rotation.flatMap((index) => live[index] ?? []);
    const selectedCount = computeFittingCount(ordered, input.drain);
    const takenCounts = computeTakenCounts(live, rotation, selectedCount);
    const lastServed = rotation.findLast((index) => (takenCounts[index] ?? 0) > 0);
    return {
        selected: ordered.slice(0, selectedCount),
        expired: input.streams.flat().filter((value) => input.nowMs >= value.expiresAtMs),
        remaining: live.map((stream, index) => stream.slice(takenCounts[index])),
        nextStartIndex: lastServed === undefined ? 0 : (lastServed + 1) % live.length
    };
}

/** The stream indices in serving order: from the cursor to the last stream, then from the first. */
function computeRotation(streamCount: number, startIndex: number): readonly number[] {
    const start = streamCount === 0 ? 0 : startIndex % streamCount;
    return Array.from({ length: streamCount }, (_, offset) => (start + offset) % streamCount);
}

/** How many values each stream gives, by stream index, when `selectedCount` are taken in rotation order. */
function computeTakenCounts<T>(
    live: readonly (readonly T[])[],
    rotation: readonly number[],
    selectedCount: number
): readonly number[] {
    const takenCounts = live.map(() => 0);
    let unassigned = selectedCount;
    for (const index of rotation) {
        const taken = Math.min(live[index]?.length ?? 0, unassigned);
        takenCounts[index] = taken;
        unassigned -= taken;
    }
    return takenCounts;
}

function computeFittingCount(
    ordered: readonly ALPublicationSelectionCandidate[],
    drain: ALPublicationDrainBudget
): number {
    let bytes = 0;
    for (const [index, value] of ordered.entries()) {
        bytes += value.bytes;
        if (index >= drain.messages || bytes > drain.bytes) {
            return index;
        }
    }
    return ordered.length;
}
