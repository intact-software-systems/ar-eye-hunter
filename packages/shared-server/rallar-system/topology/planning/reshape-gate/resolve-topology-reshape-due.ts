import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import { computeBackoffGateOpensAt, type BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

export interface ResolveTopologyReshapeDueInput {
    readonly state: TopologyReshapeGateState | null;
    readonly bounds: BackoffGateBounds;
    readonly nowEpochMs: number;
    /** The gate period the wake-up was queued under: the `gate.lastPassAtEpochMs` it was queued at. */
    readonly periodStartedAtEpochMs: number;
}

export type TopologyReshapeDue =
    | Readonly<{ decision: 'settled'; }>
    | Readonly<{ decision: 'not-due'; retryAfterMs: number; }>
    | Readonly<{ decision: 'due'; }>;

/**
 * What a held reshape's wake-up finds: a reshape since then started another period, or the want went, and it is
 * settled; the gate is still closed by this clock, and it is not due yet; otherwise the room is planned now.
 */
export function resolveTopologyReshapeDue(input: ResolveTopologyReshapeDueInput): TopologyReshapeDue {
    const { state, bounds, nowEpochMs } = input;
    if (
        state === null || state.gate.lastPassAtEpochMs !== input.periodStartedAtEpochMs ||
        state.wantedReasons.length === 0
    ) {
        return { decision: 'settled' };
    }
    const opensAtEpochMs = computeBackoffGateOpensAt(state.gate, bounds);
    return opensAtEpochMs !== null && nowEpochMs < opensAtEpochMs
        ? { decision: 'not-due', retryAfterMs: opensAtEpochMs - nowEpochMs }
        : { decision: 'due' };
}
