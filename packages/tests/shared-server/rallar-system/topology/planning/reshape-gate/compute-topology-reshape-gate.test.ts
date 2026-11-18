import { describe, expect, it } from 'vitest';

import type { HeldTopologyReshapeReason, TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import type { BackoffGateBounds, BackoffGateState } from '@shared/resilience/backoff-gate.ts';

import {
    computeTopologyReshapeGate,
    type ComputedTopologyReshapeGate,
    type TopologyReshapeGatePlanOutcome
} from '@shared-server/rallar-system/topology/planning/reshape-gate/compute-topology-reshape-gate.ts';
import { resolveTopologyReshapePermission } from '@shared-server/rallar-system/topology/planning/reshape-gate/resolve-topology-reshape-permission.ts';

const BOUNDS: BackoffGateBounds = { minIntervalMs: 15_000, maxIntervalMs: 60_000 };

function gate(lastPass: number | null, count: number, heldAt: number | null): BackoffGateState {
    return { lastPassAtEpochMs: lastPass, consecutiveHeldPasses: count, heldAtEpochMs: heldAt };
}

function state(
    gateState: BackoffGateState,
    wantedReasons: readonly HeldTopologyReshapeReason[]
): TopologyReshapeGateState {
    return { gate: gateState, wantedReasons };
}

function compute(
    previous: TopologyReshapeGateState | null,
    nowEpochMs: number,
    outcome: TopologyReshapeGatePlanOutcome
): ComputedTopologyReshapeGate {
    return computeTopologyReshapeGate({ previous, bounds: BOUNDS, nowEpochMs, outcome });
}

const FRESH = state(gate(null, 0, null), []);

describe('computeTopologyReshapeGate', () => {
    it('a first layout leaves an absent state absent and resets a used one', () => {
        expect(compute(null, 1_000, { kind: 'established' })).toEqual({ decision: 'unchanged' });
        expect(compute(FRESH, 1_000, { kind: 'established' })).toEqual({ decision: 'unchanged' });
        expect(compute(state(gate(0, 2, 3_000), ['kind-change']), 1_000, { kind: 'established' })).toEqual({
            decision: 'write',
            state: FRESH,
            wakeUpDueAtEpochMs: null
        });
    });

    it('the first hold of a period records the reason and is due when the gate opens', () => {
        expect(compute(state(gate(0, 0, null), []), 3_000, { kind: 'kept', heldReasons: ['kind-change'] })).toEqual({
            decision: 'write',
            state: state(gate(0, 0, 3_000), ['kind-change']),
            wakeUpDueAtEpochMs: 15_000
        });
    });

    it('a second hold of the period adds its reason and queues nothing', () => {
        const previous = state(gate(0, 0, 3_000), ['leader-rooting']);

        expect(compute(previous, 6_000, { kind: 'kept', heldReasons: ['kind-change'] })).toEqual({
            decision: 'write',
            state: state(gate(0, 0, 3_000), ['kind-change', 'leader-rooting']),
            wakeUpDueAtEpochMs: null
        });
    });

    it('a repeated hold of the same reason writes nothing', () => {
        const previous = state(gate(0, 0, 3_000), ['kind-change']);

        expect(compute(previous, 6_000, { kind: 'kept', heldReasons: ['kind-change'] })).toEqual({
            decision: 'unchanged'
        });
    });

    it('a reshape empties what was wanted and passes the gate', () => {
        const previous = state(gate(0, 0, 3_000), ['kind-change', 'leader-rooting']);

        expect(compute(previous, 15_000, { kind: 'reshape' })).toEqual({
            decision: 'write',
            state: state(gate(15_000, 1, null), []),
            wakeUpDueAtEpochMs: null
        });
    });

    it('an open gate with a plan that is no reshape forgets the want and keeps the hold', () => {
        const previous = state(gate(0, 0, 3_000), ['kind-change']);

        expect(compute(previous, 15_000, { kind: 'kept', heldReasons: [] })).toEqual({
            decision: 'write',
            state: state(gate(0, 0, 3_000), []),
            wakeUpDueAtEpochMs: null
        });
        expect(compute(previous, 14_999, { kind: 'kept', heldReasons: [] })).toEqual({ decision: 'unchanged' });
    });

    it('a hold whose want has gone still doubles the next interval', () => {
        expect(compute(state(gate(0, 0, 3_000), []), 18_000, { kind: 'reshape' })).toEqual({
            decision: 'write',
            state: state(gate(18_000, 1, null), []),
            wakeUpDueAtEpochMs: null
        });
    });

    it('a room flapping every 3 s is reshaped at 0, 18, 48, 108 and 168 s, not every 15 s', () => {
        const reshapes = simulateFlappingRoom(180_000);

        const gaps = reshapes.slice(1).map((instant, index) => instant - (reshapes[index] ?? 0));
        expect(reshapes).toEqual([0, 18_000, 48_000, 108_000, 168_000]);
        expect(gaps).toEqual([18_000, 30_000, 60_000, 60_000]);
        expect(gaps[0]).toBeGreaterThanOrEqual(15_000);
        expect(gaps[1]).toBeGreaterThanOrEqual(30_000);
        expect(gaps.slice(2).length).toBeGreaterThan(0);
        expect(gaps.slice(2).every((gap) => gap >= 60_000)).toBe(true);
        expect(reshapes.filter((instant) => instant <= 90_000).length).toBeLessThanOrEqual(4);
    });
});

function simulateFlappingRoom(untilEpochMs: number): readonly number[] {
    const reshapes: number[] = [];
    let current: TopologyReshapeGateState | null = null;
    for (let nowEpochMs = 0, event = 0; nowEpochMs <= untilEpochMs; nowEpochMs += 3_000, event += 1) {
        const wantsReshape = event % 2 === 0;
        const permission = resolveTopologyReshapePermission({
            state: current,
            bounds: BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs
        });
        const outcome: TopologyReshapeGatePlanOutcome = !wantsReshape
            ? { kind: 'kept', heldReasons: [] }
            : permission.reshape === 'allowed'
            ? { kind: 'reshape' }
            : { kind: 'kept', heldReasons: ['kind-change'] };
        if (outcome.kind === 'reshape') {
            reshapes.push(nowEpochMs);
        }
        const computed = computeTopologyReshapeGate({ previous: current, bounds: BOUNDS, nowEpochMs, outcome });
        current = computed.decision === 'write' ? computed.state : current;
    }
    return reshapes;
}
