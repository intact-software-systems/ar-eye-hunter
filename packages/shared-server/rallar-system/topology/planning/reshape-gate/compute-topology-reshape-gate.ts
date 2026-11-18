import {
    HELD_TOPOLOGY_RESHAPE_REASONS,
    type HeldTopologyReshapeReason,
    type TopologyReshapeGateState
} from '@shared/api/topology-plan/topology-reshape-gate.ts';
import {
    computeBackoffGateHold,
    computeBackoffGateOpensAt,
    computeBackoffGatePass,
    isBackoffGateOpen,
    type BackoffGateBounds
} from '@shared/resilience/backoff-gate.ts';

export type TopologyReshapeGatePlanOutcome =
    | Readonly<{ kind: 'established'; }>
    | Readonly<{ kind: 'reshape'; }>
    | Readonly<{ kind: 'kept'; heldReasons: readonly HeldTopologyReshapeReason[]; }>;

export interface ComputeTopologyReshapeGateInput {
    readonly previous: TopologyReshapeGateState | null;
    readonly bounds: BackoffGateBounds;
    readonly nowEpochMs: number;
    readonly outcome: TopologyReshapeGatePlanOutcome;
}

export type ComputedTopologyReshapeGate =
    | Readonly<{ decision: 'unchanged'; }>
    | Readonly<{ decision: 'write'; state: TopologyReshapeGateState; wakeUpDueAtEpochMs: number | null; }>;

const UNCHANGED: ComputedTopologyReshapeGate = { decision: 'unchanged' };

const FRESH_TOPOLOGY_RESHAPE_GATE_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null },
    wantedReasons: []
};

export function computeTopologyReshapeGate(input: ComputeTopologyReshapeGateInput): ComputedTopologyReshapeGate {
    const { previous, bounds, nowEpochMs, outcome } = input;
    switch (outcome.kind) {
        case 'established':
            return previous === null || isFreshTopologyReshapeGateState(previous)
                ? UNCHANGED
                : { decision: 'write', state: FRESH_TOPOLOGY_RESHAPE_GATE_STATE, wakeUpDueAtEpochMs: null };
        case 'reshape': {
            const gate = computeBackoffGatePass({ state: previous?.gate ?? null, bounds, nowEpochMs });
            return { decision: 'write', state: { gate, wantedReasons: [] }, wakeUpDueAtEpochMs: null };
        }
        case 'kept':
            return computeKeptTopologyReshapeGate(input, outcome.heldReasons);
    }
}

function computeKeptTopologyReshapeGate(
    input: ComputeTopologyReshapeGateInput,
    heldReasons: readonly HeldTopologyReshapeReason[]
): ComputedTopologyReshapeGate {
    const { previous, bounds, nowEpochMs } = input;
    if (previous === null || previous.gate.lastPassAtEpochMs === null) {
        return UNCHANGED;
    }
    if (heldReasons.length > 0) {
        return computeHeldTopologyReshapeGate({ previous, bounds, nowEpochMs }, heldReasons);
    }
    if (previous.wantedReasons.length > 0 && isBackoffGateOpen(previous.gate, bounds, nowEpochMs)) {
        return { decision: 'write', state: { ...previous, wantedReasons: [] }, wakeUpDueAtEpochMs: null };
    }
    return UNCHANGED;
}

interface HeldTopologyReshapeGateInput {
    readonly previous: TopologyReshapeGateState;
    readonly bounds: BackoffGateBounds;
    readonly nowEpochMs: number;
}

function computeHeldTopologyReshapeGate(
    input: HeldTopologyReshapeGateInput,
    heldReasons: readonly HeldTopologyReshapeReason[]
): ComputedTopologyReshapeGate {
    const { previous, bounds, nowEpochMs } = input;
    const wantedReasons = HELD_TOPOLOGY_RESHAPE_REASONS.filter((reason) =>
        previous.wantedReasons.includes(reason) || heldReasons.includes(reason)
    );
    const isFirstHold = previous.gate.heldAtEpochMs === null;
    if (!isFirstHold && wantedReasons.length === previous.wantedReasons.length) {
        return UNCHANGED;
    }
    return {
        decision: 'write',
        state: { gate: computeBackoffGateHold(previous.gate, nowEpochMs), wantedReasons },
        wakeUpDueAtEpochMs: isFirstHold ? computeBackoffGateOpensAt(previous.gate, bounds) : null
    };
}

function isFreshTopologyReshapeGateState(state: TopologyReshapeGateState): boolean {
    const { gate } = state;
    return gate.lastPassAtEpochMs === null && gate.consecutiveHeldPasses === 0 && gate.heldAtEpochMs === null &&
        state.wantedReasons.length === 0;
}
