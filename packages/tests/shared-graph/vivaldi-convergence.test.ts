import { describe, expect, it } from 'vitest';
import { VivaldiNode, type VivaldiConfig } from '@shared-graph/graph/vivaldi-core.ts';

// The peer sits at the origin, so the node's own norm is the predicted RTT to
// it. A fixed draw makes the tie-break on the first sample reproducible; every
// sample after that is separated and fully deterministic anyway.
function toTrajectory(
    input: Readonly<{
        rttMs: number;
        samples: number;
        remoteErr?: number;
        initialError?: number;
        cfg?: Partial<VivaldiConfig>;
        node?: VivaldiNode;
    }>,
): Readonly<{ node: VivaldiNode; predicted: number[]; errors: number[] }> {
    const node = input.node ?? new VivaldiNode({
        dimensions: 2,
        initialError: input.initialError,
        cfg: input.cfg,
        random: () => 1,
    });
    const predicted: number[] = [];
    const errors: number[] = [];

    for (let sample = 0; sample < input.samples; sample++) {
        node.update({
            id: 'peer',
            coords: [0, 0],
            err: input.remoteErr ?? 1.0,
            rttMs: input.rttMs,
        });
        predicted.push(node.coords.norm());
        errors.push(node.myError);
    }

    return { node, predicted, errors };
}

function isMonotonic(values: readonly number[], direction: 'up' | 'down'): boolean {
    return values.every((value, index) =>
        index === 0 ||
        (direction === 'up' ? value > values[index - 1] : value < values[index - 1])
    );
}

describe('VivaldiNode.update convergence', () => {
    // The first two steps are hand-checkable and anchor the constants, so a
    // change to cc, ce or the weighting cannot hide behind the long runs below.
    // Step 1: cc * weight * diffErr = 0.25 * 0.5 * 50 = 6.25.
    // Step 2: 6.25 + 0.125 * (50 - 6.25) = 11.71875.
    // Error 2: 0.875 * 0.25 + 1.0 * 0.75 = 0.96875.
    it('takes the exact steps the constants call for', () => {
        const { predicted, errors } = toTrajectory({ rttMs: 50, samples: 2 });

        expect(predicted[0]).toBeCloseTo(6.25, 12);
        expect(predicted[1]).toBeCloseTo(11.71875, 12);
        expect(errors[0]).toBe(1.0);
        expect(errors[1]).toBeCloseTo(0.96875, 12);
    });

    it('approaches the measured RTT from below without overshooting', () => {
        const { predicted } = toTrajectory({ rttMs: 50, samples: 200 });

        expect(isMonotonic(predicted, 'up')).toBe(true);
        expect(Math.max(...predicted)).toBeLessThan(50);
        expect(predicted[predicted.length - 1]).toBeGreaterThan(49);
    });

    // The sign of diffErr has to work in both directions: a node that is
    // already too far away must be pulled back in, not pushed further out.
    it('moves back toward the peer when it is too far away', () => {
        const settled = toTrajectory({ rttMs: 50, samples: 200 });
        expect(settled.predicted[199]).toBeGreaterThan(49);

        const corrected = toTrajectory({ rttMs: 10, samples: 200, node: settled.node });

        expect(isMonotonic(corrected.predicted, 'down')).toBe(true);
        expect(corrected.predicted[199]).toBeLessThan(10.5);
        expect(corrected.predicted[199]).toBeGreaterThan(10);
    });

    it('decays the error once the samples start agreeing', () => {
        const { errors } = toTrajectory({ rttMs: 50, samples: 200 });

        // The first sample lands on the clamp, so decay is measured from there.
        expect(isMonotonic(errors.slice(1), 'down')).toBe(true);
        expect(errors[199]).toBeLessThan(0.05);
    });
});

describe('VivaldiNode.update error clamping', () => {
    // A settled node told the peer is 1ms away sees a sample error of roughly
    // 494, which without the clamp would leave myError far above 1.
    it('clamps at maxNodeErr when a sample contradicts the position', () => {
        const settled = toTrajectory({ rttMs: 500, samples: 200 });
        expect(settled.node.myError).toBeLessThan(0.05);

        settled.node.update({ id: 'peer', coords: [0, 0], err: 0.0, rttMs: 1 });

        expect(settled.node.myError).toBe(1.0);
    });

    it('honours a custom maxNodeErr', () => {
        const { node } = toTrajectory({
            rttMs: 50,
            samples: 1,
            initialError: 1.0,
            cfg: { maxNodeErr: 0.6 },
        });

        expect(node.myError).toBe(0.6);
    });

    // Without a floor the error decays toward zero asymptotically, so a
    // configured floor is the only way to observe the lower clamp at all.
    it('stops decaying at minNodeErr', () => {
        const { errors } = toTrajectory({
            rttMs: 50,
            samples: 300,
            cfg: { minNodeErr: 0.4 },
        });

        expect(errors[19]).toBe(0.4);
        expect(errors[299]).toBe(0.4);
    });

    it('keeps the error inside its bounds throughout a run', () => {
        const { errors } = toTrajectory({ rttMs: 50, samples: 200 });

        expect(errors.every((error) => error >= 0.0 && error <= 1.0)).toBe(true);
    });
});
