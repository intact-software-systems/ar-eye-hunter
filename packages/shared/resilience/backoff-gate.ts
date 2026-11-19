import { toExponentialBackoffMs } from './ComputeAsyncTask.ts';

/** A gate that lets one pass through per interval. The caller stores the state; every function is pure. */
export interface BackoffGateState {
    /** When the last pass went through; null before the first. */
    readonly lastPassAtEpochMs: number | null;
    /** Passes in a row that had been held first; the interval doubles with each, up to the upper bound. */
    readonly consecutiveHeldPasses: number;
    /** When a pass was first held since the last one; null when none was. */
    readonly heldAtEpochMs: number | null;
}

export interface BackoffGateBounds {
    readonly minIntervalMs: number;
    readonly maxIntervalMs: number;
}

export interface ComputeBackoffGatePassInput {
    readonly state: BackoffGateState | null;
    readonly bounds: BackoffGateBounds;
    readonly nowEpochMs: number;
}

export function computeBackoffGateIntervalMs(state: BackoffGateState | null, bounds: BackoffGateBounds): number {
    const heldPasses = state?.consecutiveHeldPasses ?? 0;
    return toExponentialBackoffMs(heldPasses + 1, bounds.maxIntervalMs, bounds.minIntervalMs);
}

/** Null before the first pass: the gate is open. */
export function computeBackoffGateOpensAt(state: BackoffGateState | null, bounds: BackoffGateBounds): number | null {
    if (state === null || state.lastPassAtEpochMs === null) {
        return null;
    }
    return state.lastPassAtEpochMs + computeBackoffGateIntervalMs(state, bounds);
}

export function isBackoffGateOpen(
    state: BackoffGateState | null,
    bounds: BackoffGateBounds,
    nowEpochMs: number
): boolean {
    const opensAt = computeBackoffGateOpensAt(state, bounds);
    return opensAt === null || nowEpochMs >= opensAt;
}

export function computeBackoffGatePass(input: ComputeBackoffGatePassInput): BackoffGateState {
    return {
        lastPassAtEpochMs: input.nowEpochMs,
        consecutiveHeldPasses: computeNextHeldPasses(input),
        heldAtEpochMs: null
    };
}

/** Records the first hold since the last pass; a later hold returns the state as it is. */
export function computeBackoffGateHold(state: BackoffGateState, nowEpochMs: number): BackoffGateState {
    if (state.heldAtEpochMs !== null) {
        return state;
    }
    return { ...state, heldAtEpochMs: nowEpochMs };
}

/**
 * The count the next interval doubles by, in three cases: a pass that had been held first, within twice the interval
 * of the last pass, counts one more, unless the interval is already the upper bound; otherwise a pass through an open
 * gate resets the count, and a pass through a closed gate with nothing held keeps it.
 */
function computeNextHeldPasses(input: ComputeBackoffGatePassInput): number {
    const { state, bounds, nowEpochMs } = input;
    if (state === null || state.lastPassAtEpochMs === null) {
        return 0;
    }
    const intervalMs = computeBackoffGateIntervalMs(state, bounds);
    if (state.heldAtEpochMs !== null && nowEpochMs < state.lastPassAtEpochMs + 2 * intervalMs) {
        return intervalMs >= bounds.maxIntervalMs ? state.consecutiveHeldPasses : state.consecutiveHeldPasses + 1;
    }
    if (isBackoffGateOpen(state, bounds, nowEpochMs)) {
        return 0;
    }
    return state.consecutiveHeldPasses;
}
