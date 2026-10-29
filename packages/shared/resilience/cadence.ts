export interface CadenceInput {
    /** When the cadence last fired; undefined when it never did. */
    readonly lastAtMs: number | undefined;
    readonly cadenceMs: number;
    readonly nowMs: number;
}

/**
 * One cadence after the last, or now when that boundary has already passed: a caller reached late gets one bounded
 * opportunity, never a catch-up burst.
 */
export function computeNextCadenceAtMs(input: CadenceInput): number {
    if (input.lastAtMs === undefined) {
        return input.nowMs;
    }
    return Math.max(input.lastAtMs + input.cadenceMs, input.nowMs);
}

export function isCadenceDue(input: CadenceInput): boolean {
    return input.cadenceMs <= 0 || input.lastAtMs === undefined || input.nowMs >= input.lastAtMs + input.cadenceMs;
}
