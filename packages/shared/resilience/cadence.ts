export interface CadenceInput {
    /** When the cadence last fired; undefined when it never did. */
    readonly lastAtMs: number | undefined;
    readonly cadenceMs: number;
    readonly nowMs: number;
}

export interface CadenceBoundaryInput {
    readonly lastAtMs: number;
    readonly cadenceMs: number;
}

export interface CadenceDueInput {
    readonly boundaryAtMs: number;
    readonly cadenceMs: number;
    readonly nowMs: number;
}

/** One cadence after the last. A boundary already behind now stays behind now. */
export function computeCadenceBoundaryAtMs(input: CadenceBoundaryInput): number {
    return input.lastAtMs + input.cadenceMs;
}

/**
 * The boundary, or now when there was no last or the boundary has already passed: a caller reached late gets one
 * bounded opportunity, never a catch-up burst.
 */
export function computeNextCadenceAtMs(input: CadenceInput): number {
    if (input.lastAtMs === undefined) {
        return input.nowMs;
    }
    return Math.max(computeCadenceBoundaryAtMs({ lastAtMs: input.lastAtMs, cadenceMs: input.cadenceMs }), input.nowMs);
}

/** Due when the cadence is zero or negative, or when now has reached the boundary. */
export function isCadenceDue(input: CadenceDueInput): boolean {
    return input.cadenceMs <= 0 || input.nowMs >= input.boundaryAtMs;
}
