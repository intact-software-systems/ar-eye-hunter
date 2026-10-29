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
}

export interface ALPublicationSelection<T extends ALPublicationSelectionCandidate> {
    readonly selected: readonly T[];
    readonly expired: readonly T[];
    /** Aligned with the input streams by index: what each still holds for a later opportunity. */
    readonly remaining: readonly (readonly T[])[];
}

/**
 * Expired values leave first and spend no budget; the rest are taken in stream order, each stream oldest first,
 * until the next value would pass the message or byte budget, and everything after it waits (D469).
 */
export function computeALPublicationSelection<T extends ALPublicationSelectionCandidate>(
    input: ComputeALPublicationSelectionInput<T>
): ALPublicationSelection<T> {
    const live = input.streams.map((stream) => stream.filter((value) => input.nowMs < value.expiresAtMs));
    const ordered = live.flat();
    const selectedCount = computeFittingCount(ordered, input.drain);
    let unassigned = selectedCount;
    const remaining = live.map((stream) => {
        const taken = Math.min(stream.length, unassigned);
        unassigned -= taken;
        return stream.slice(taken);
    });
    return {
        selected: ordered.slice(0, selectedCount),
        expired: input.streams.flat().filter((value) => input.nowMs >= value.expiresAtMs),
        remaining
    };
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
