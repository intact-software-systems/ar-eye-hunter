import { describe, expect, it } from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeTopologyReshapeGateState } from '@shared/api/topology-plan/decode-topology-reshape-gate-state.ts';
import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';

const HELD_STATE = {
    gate: { lastPassAtEpochMs: 1_700_000_000_000, consecutiveHeldPasses: 2, heldAtEpochMs: 1_700_000_003_000 },
    wantedReasons: ['kind-change', 'leader-rooting']
};

describe('decodeTopologyReshapeGateState', () => {
    it('round-trips a valid state', () => {
        const fresh: TopologyReshapeGateState = {
            gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null },
            wantedReasons: []
        };

        expect(decodeTopologyReshapeGateState(HELD_STATE).right).toEqual(HELD_STATE);
        expect(decodeTopologyReshapeGateState({ ...fresh, gate: { ...fresh.gate } }).right).toEqual(fresh);
    });

    it.each<[string, ApiJsonValue]>([
        ['an unknown key on the state', { ...HELD_STATE, extra: 1 }],
        ['an unknown key on the gate', { ...HELD_STATE, gate: { ...HELD_STATE.gate, extra: 1 } }],
        ['a missing key on the gate', { ...HELD_STATE, gate: { lastPassAtEpochMs: 0, consecutiveHeldPasses: 0 } }],
        ['a negative number', { ...HELD_STATE, gate: { ...HELD_STATE.gate, consecutiveHeldPasses: -1 } }],
        ['a fractional number', { ...HELD_STATE, gate: { ...HELD_STATE.gate, lastPassAtEpochMs: 1.5 } }],
        ['a reason outside the known reasons', { ...HELD_STATE, wantedReasons: ['kind-change', 'rtt'] }],
        ['a duplicate reason', { ...HELD_STATE, wantedReasons: ['kind-change', 'kind-change'] }],
        ['reasons out of order', { ...HELD_STATE, wantedReasons: ['leader-rooting', 'kind-change'] }],
        [
            'a hold without a previous pass',
            { ...HELD_STATE, gate: { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: 3_000 } }
        ],
        ['a value that is no object', 'gate']
    ])('refuses %s', (_label, value) => {
        expect(decodeTopologyReshapeGateState(value).left).toEqual(expect.any(String));
    });
});
