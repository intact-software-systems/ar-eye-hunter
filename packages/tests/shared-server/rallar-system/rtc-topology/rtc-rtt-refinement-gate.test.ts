import { describe, expect, it } from 'vitest';
// prettier-ignore
import {
    RtcRttRefinementGate,
} from '@shared-server/rallar-system/rtc-topology/topic/rtc-rtt-refinement-gate.ts';

describe('rtc rtt refinement gate', () => {
    it('accumulates sub-threshold movement without refining, then refines once', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 0,
            vivaldiDeltaThresholdMs: 10,
        });

        expect(claim(gate, 'g-1', 4, 1_000)).toBe(false);
        expect(claim(gate, 'g-1', 4, 1_000)).toBe(false);
        expect(claim(gate, 'g-1', 4, 1_000)).toBe(true);
        expect(claim(gate, 'g-1', 4, 1_000)).toBe(false);
    });

    it('enforces the per-group interval floor while movement keeps accumulating', () => {
        let nowEpochMs = 1_000;
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5,
        });

        expect(claim(gate, 'g-1', 20, nowEpochMs)).toBe(true);
        expect(claim(gate, 'g-1', 20, nowEpochMs)).toBe(false);

        nowEpochMs += 29_000;
        expect(claim(gate, 'g-1', 20, nowEpochMs)).toBe(false);

        nowEpochMs += 1_000;
        expect(claim(gate, 'g-1', 0, nowEpochMs)).toBe(true);
    });

    it('gates groups independently', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5,
        });

        expect(claim(gate, 'g-1', 20, 1_000)).toBe(true);
        expect(claim(gate, 'g-2', 20, 1_000)).toBe(true);
        expect(claim(gate, 'g-1', 20, 1_000)).toBe(false);
    });

    it('treats a first observation (infinite delta) as refinement-worthy', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 30_000,
            vivaldiDeltaThresholdMs: 5,
        });

        expect(
            gate.claimRefinement({
                groupKey: 'g-1',
                predictedDeltaMs: Number.POSITIVE_INFINITY,
                nowEpochMs: 1_000,
            }),
        ).toBe(true);
    });

    it('keeps per-report refinement with both knobs at zero', () => {
        const gate = new RtcRttRefinementGate({
            minIntervalMs: 0,
            vivaldiDeltaThresholdMs: 0,
        });

        expect(claim(gate, 'g-1', 0, 1_000)).toBe(true);
        expect(claim(gate, 'g-1', 0, 1_000)).toBe(true);
    });
});

function claim(
    gate: RtcRttRefinementGate,
    groupKey: string,
    predictedDeltaMs: number,
    nowEpochMs: number,
): boolean {
    return gate.claimRefinement({ groupKey, predictedDeltaMs, nowEpochMs });
}
