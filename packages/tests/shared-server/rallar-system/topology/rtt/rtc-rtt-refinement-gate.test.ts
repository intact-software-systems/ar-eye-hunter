import { describe, expect, it } from 'vitest';
// prettier-ignore
import {
    RtcRttRefinementGate,
} from '@shared-server/rallar-system/topology/rtt/rtc-rtt-refinement-gate.ts';

describe('rtc rtt refinement gate', () => {
    it('accumulates sub-threshold movement without refining, then refines once', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 0,
            vivaldiDeltaThresholdMs: 10,
            now: () => 1_000,
        });

        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 4 })).toBe(false);
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 4 })).toBe(false);
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 4 })).toBe(true);
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 4 })).toBe(false);
    });

    it('enforces the per-group interval floor while movement keeps accumulating', () => {
        let nowEpochMs = 1_000;
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5,
            now: () => nowEpochMs,
        });

        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 20 })).toBe(true);
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 20 })).toBe(false);

        nowEpochMs += 29_000;
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 20 })).toBe(false);

        nowEpochMs += 1_000;
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 0 })).toBe(true);
    });

    it('gates groups independently', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5,
            now: () => 1_000,
        });

        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 20 })).toBe(true);
        expect(gate.claimRefinement({ groupKey: 'g-2', predictedDeltaMs: 20 })).toBe(true);
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 20 })).toBe(false);
    });

    it('treats a first observation (infinite delta) as refinement-worthy', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5,
            now: () => 1_000,
        });

        expect(
            gate.claimRefinement({
                groupKey: 'g-1',
                predictedDeltaMs: Number.POSITIVE_INFINITY,
            }),
        ).toBe(true);
    });

    it('keeps per-report refinement with both knobs at zero', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 0,
            vivaldiDeltaThresholdMs: 0,
            now: () => 1_000,
        });

        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 0 })).toBe(true);
        expect(gate.claimRefinement({ groupKey: 'g-1', predictedDeltaMs: 0 })).toBe(true);
    });
});
