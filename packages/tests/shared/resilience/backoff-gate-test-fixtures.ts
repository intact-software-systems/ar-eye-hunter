import type { BackoffGateBounds, BackoffGateState } from '@shared/resilience/backoff-gate.ts';

/** The bounds the gate tests run under: they match the default preset's reshape interval bounds. */
export const BACKOFF_GATE_TEST_BOUNDS: BackoffGateBounds = { minIntervalMs: 15_000, maxIntervalMs: 60_000 };

export function toBackoffGateState(lastPass: number | null, count: number, heldAt: number | null): BackoffGateState {
    return { lastPassAtEpochMs: lastPass, consecutiveHeldPasses: count, heldAtEpochMs: heldAt };
}
