import { describe, expect, it } from 'vitest';

import type { TopologyReshapeGateState } from '@shared/api/topology-plan/topology-reshape-gate.ts';
import type { BackoffGateBounds } from '@shared/resilience/backoff-gate.ts';

import { resolveTopologyReshapePermission } from '@shared-server/rallar-system/topology/planning/reshape-gate/resolve-topology-reshape-permission.ts';

const BOUNDS: BackoffGateBounds = { minIntervalMs: 15_000, maxIntervalMs: 60_000 };

const HELD_STATE: TopologyReshapeGateState = {
    gate: { lastPassAtEpochMs: 0, consecutiveHeldPasses: 0, heldAtEpochMs: 3_000 },
    wantedReasons: ['leader-rooting']
};

describe('resolveTopologyReshapePermission', () => {
    it('allows an automatic reshape of a room with no gate state, owing nothing', () => {
        expect(resolveTopologyReshapePermission({
            state: null,
            bounds: BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs: 1_000
        })).toEqual({ reshape: 'allowed', wantedReasons: [] });
    });

    it('holds an automatic reshape while the gate is closed', () => {
        expect(resolveTopologyReshapePermission({
            state: HELD_STATE,
            bounds: BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs: 14_999
        })).toEqual({ reshape: 'held' });
    });

    it('allows an automatic reshape through an open gate with the reasons still wanted', () => {
        expect(resolveTopologyReshapePermission({
            state: HELD_STATE,
            bounds: BOUNDS,
            workOrigin: 'automatic',
            nowEpochMs: 15_000
        })).toEqual({ reshape: 'allowed', wantedReasons: ['leader-rooting'] });
    });

    it('allows commanded work while the gate is closed, with the reasons still wanted', () => {
        expect(resolveTopologyReshapePermission({
            state: HELD_STATE,
            bounds: BOUNDS,
            workOrigin: 'commanded',
            nowEpochMs: 5_000
        })).toEqual({ reshape: 'allowed', wantedReasons: ['leader-rooting'] });
    });

    it('allows commanded work in a room with no gate state, owing nothing', () => {
        expect(resolveTopologyReshapePermission({
            state: null,
            bounds: BOUNDS,
            workOrigin: 'commanded',
            nowEpochMs: 5_000
        })).toEqual({ reshape: 'allowed', wantedReasons: [] });
    });
});
