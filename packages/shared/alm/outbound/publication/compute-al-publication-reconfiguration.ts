import type { ALPublicationPolicy } from '../../../al-contracts/publication/al-publication-policy.ts';
import { retainNewest } from '../../../cache/retain-newest.ts';
import { computeNextCadenceAtMs } from '../../../resilience/cadence.ts';
import type { ALPublicationSelectionCandidate } from './compute-al-publication-selection.ts';

export interface ComputeALPublicationReconfigurationInput<T extends ALPublicationSelectionCandidate> {
    /** The lane's streams in their first-staged order, each oldest first. */
    readonly streams: readonly (readonly T[])[];
    readonly policy: ALPublicationPolicy;
    readonly lastOpportunityAtMs: number | undefined;
    readonly nextOpportunityAtMs: number | undefined;
    readonly nowMs: number;
}

export interface ALPublicationSupersession<T extends ALPublicationSelectionCandidate> {
    readonly displaced: T;
    readonly replacement: T;
}

export interface ALPublicationReconfiguration<T extends ALPublicationSelectionCandidate> {
    /** Aligned with the input streams by index: what each holds under the new policy. */
    readonly remaining: readonly (readonly T[])[];
    readonly superseded: readonly ALPublicationSupersession<T>[];
    readonly oversized: readonly T[];
    readonly nextOpportunityAtMs: number | undefined;
}

/**
 * A lane adopting a new policy (D479). A value the new drain budget cannot hold leaves first, so a stream keeps its
 * newest value that an opportunity can still select; each stream then keeps its newest `retainNewest`, and its newest
 * value replaces what fell off. A scheduled boundary only moves earlier, to one new cadence after the last
 * opportunity, so the lane still runs one opportunity; no deadline changes.
 */
export function computeALPublicationReconfiguration<T extends ALPublicationSelectionCandidate>(
    input: ComputeALPublicationReconfigurationInput<T>
): ALPublicationReconfiguration<T> {
    const { policy } = input;
    const fitting = input.streams.map((stream) => stream.filter((value) => value.bytes <= policy.drain.bytes));
    const trims = fitting.map((stream) => stream.length === 0 ? undefined : retainNewest(stream, policy.retainNewest));
    return {
        remaining: trims.map((trim) => trim?.retained ?? []),
        superseded: trims.flatMap((trim) => toSupersessions(trim?.displaced ?? [], trim?.retained.at(-1))),
        oversized: input.streams.flat().filter((value) => value.bytes > policy.drain.bytes),
        nextOpportunityAtMs: input.nextOpportunityAtMs === undefined ? undefined : Math.min(
            input.nextOpportunityAtMs,
            computeNextCadenceAtMs({
                lastAtMs: input.lastOpportunityAtMs,
                cadenceMs: policy.cadenceMs,
                nowMs: input.nowMs
            })
        )
    };
}

export function isSameALPublicationPolicy(left: ALPublicationPolicy, right: ALPublicationPolicy): boolean {
    return left.cadenceMs === right.cadenceMs && left.retainNewest === right.retainNewest &&
        left.drain.messages === right.drain.messages && left.drain.bytes === right.drain.bytes;
}

function toSupersessions<T extends ALPublicationSelectionCandidate>(
    displaced: readonly T[],
    replacement: T | undefined
): readonly ALPublicationSupersession<T>[] {
    return replacement === undefined ? [] : displaced.map((value) => ({ displaced: value, replacement }));
}
