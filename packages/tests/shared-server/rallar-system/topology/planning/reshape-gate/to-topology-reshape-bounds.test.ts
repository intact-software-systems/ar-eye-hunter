import { describe, expect, it } from 'vitest';

import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

import { toTopologyReshapeBounds } from '@shared-server/rallar-system/topology/planning/reshape-gate/to-topology-reshape-bounds.ts';

const DEFAULT_BOUNDS = { minIntervalMs: 15_000, maxIntervalMs: 60_000 };

describe('toTopologyReshapeBounds', () => {
    it('takes a stored policy\'s bounds, the lower as the minimum and the upper as the maximum', () => {
        const preset = createDefaultGroupLifecyclePolicy();
        const policy = {
            ...preset,
            topology: { ...preset.topology, reshapeMinIntervalMs: 20_000, reshapeMaxIntervalMs: 45_000 }
        };

        expect(toTopologyReshapeBounds({ status: 'present', policy }))
            .toEqual({ minIntervalMs: 20_000, maxIntervalMs: 45_000 });
    });

    it('takes the default preset\'s bounds for a room with no stored policy', () => {
        expect(toTopologyReshapeBounds({ status: 'absent' })).toEqual(DEFAULT_BOUNDS);
    });

    it('takes the default preset\'s bounds for an unreadable policy', () => {
        expect(toTopologyReshapeBounds({ status: 'corrupt', reason: 'Stored policy does not decode' })).toEqual(DEFAULT_BOUNDS);
    });
});
