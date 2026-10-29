export interface ComputeALPublicationNextOpportunityInput {
    /** When the lane last ran an opportunity; undefined for a lane that never ran one. */
    readonly lastOpportunityAtMs: number | undefined;
    readonly cadenceMs: number;
    readonly nowMs: number;
}

/**
 * One cadence after the last opportunity, or now when that boundary has already passed: a lane the engine reaches
 * late runs one bounded opportunity, never a catch-up burst (D469).
 */
export function computeALPublicationNextOpportunityAtMs(input: ComputeALPublicationNextOpportunityInput): number {
    if (input.lastOpportunityAtMs === undefined) {
        return input.nowMs;
    }
    return Math.max(input.lastOpportunityAtMs + input.cadenceMs, input.nowMs);
}
