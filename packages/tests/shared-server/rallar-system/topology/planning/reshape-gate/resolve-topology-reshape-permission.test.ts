import { describe, expect, it } from 'vitest';

import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import { resolveTopologyReshapePermission } from '@shared-server/rallar-system/topology/planning/reshape-gate/resolve-topology-reshape-permission.ts';
import { BACKOFF_GATE_TEST_BOUNDS } from '../../../../../shared/resilience/backoff-gate-test-fixtures.ts';

const HELD_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: 0, consecutiveHeldPasses: 0, heldAtEpochMs: 3_000 },
    wantedReasons: ['leader-rooting']
};

describe('resolveTopologyReshapePermission', () => {
    it('allows an automatic reshape of a room with no gate state, owing nothing', () => {
        expect(resolveTopologyReshapePermission({
            state: null,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs: 1_000
        })).toEqual({ reshape: 'allowed', wantedReasons: [] });
    });

    it('holds an automatic reshape while the gate is closed', () => {
        expect(resolveTopologyReshapePermission({
            state: HELD_STATE,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs: 14_999
        })).toEqual({ reshape: 'held' });
    });

    it('allows an automatic reshape through an open gate with the reasons still wanted', () => {
        expect(resolveTopologyReshapePermission({
            state: HELD_STATE,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs: 15_000
        })).toEqual({ reshape: 'allowed', wantedReasons: ['leader-rooting'] });
    });

    it('allows commanded work while the gate is closed, with the reasons still wanted', () => {
        expect(resolveTopologyReshapePermission({
            state: HELD_STATE,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            workOrigin: 'commanded',
            nowEpochMs: 5_000
        })).toEqual({ reshape: 'allowed', wantedReasons: ['leader-rooting'] });
    });

    it('allows commanded work in a room with no gate state, owing nothing', () => {
        expect(resolveTopologyReshapePermission({
            state: null,
            bounds: BACKOFF_GATE_TEST_BOUNDS,
            workOrigin: 'commanded',
            nowEpochMs: 5_000
        })).toEqual({ reshape: 'allowed', wantedReasons: [] });
    });
});
