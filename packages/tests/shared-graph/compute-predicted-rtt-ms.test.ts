import { computePredictedRttMs, Coordinates, DEFAULT_VIVALDI_CONFIG, type VivaldiConfig, type VivaldiNodeData } from '@shared-graph/graph/vivaldi-core.ts';
import { describe, expect, it } from 'vitest';

// computePredictedRttMs replaced a Coordinates-based distance with a direct
// loop to stop allocating per pair at O(N^2) call sites. Coordinates is still
// the authority for what the distance means, so it is the oracle here: the
// optimization is only correct if it agrees with it on every norm, including
// the two nothing in the repository currently switches on.
describe('computePredictedRttMs', () => {
    it.each([
        { norm: 'L2 (default)', overrides: {} },
        { norm: 'L1', overrides: { useL1: true } },
        { norm: 'L-infinity', overrides: { useLInf: true } },
        { norm: 'L-infinity wins over L1', overrides: { useL1: true, useLInf: true } }
    ])('agrees with Coordinates.distance for $norm', ({ overrides }) => {
        const cfg: VivaldiConfig = { ...DEFAULT_VIVALDI_CONFIG, ...overrides };
        for (const [source, target] of createCoordinatePairs()) {
            const expected = new Coordinates(source.coords, cfg)
                .distance(new Coordinates(target.coords, cfg));
            expect(computePredictedRttMs(source, target, cfg)).toBe(expected);
        }
    });

    it('rejects coordinates of differing dimension', () => {
        const source = toNode('peer-a', [1, 2]);
        const target = toNode('peer-b', [1, 2, 3]);
        expect(() => computePredictedRttMs(source, target, DEFAULT_VIVALDI_CONFIG)).toThrow(
            'Coordinates must have the same dimension'
        );
    });

    it('is symmetric and zero for identical coordinates', () => {
        for (const [source, target] of createCoordinatePairs()) {
            expect(computePredictedRttMs(source, target, DEFAULT_VIVALDI_CONFIG)).toBe(
                computePredictedRttMs(target, source, DEFAULT_VIVALDI_CONFIG)
            );
        }
        const node = toNode('peer-a', [3, -7, 11]);
        expect(computePredictedRttMs(node, toNode('peer-b', [3, -7, 11]), DEFAULT_VIVALDI_CONFIG))
            .toBe(0);
    });
});

function createCoordinatePairs(): (readonly [VivaldiNodeData, VivaldiNodeData])[] {
    // Negative and zero components included: the L1 and L-infinity branches
    // take absolute values, which a non-negative fixture would not exercise.
    const vectors = [
        [0, 0],
        [3, 4],
        [-3, 4],
        [-1, -1],
        [0.5, -2.25],
        [10, 0, -5],
        [-10, 0.125, 5],
        [1, 2, 3, 4],
        [-1, -2, -3, -4]
    ];
    const pairs: (readonly [VivaldiNodeData, VivaldiNodeData])[] = [];
    for (const source of vectors) {
        for (const target of vectors) {
            if (source.length === target.length) {
                pairs.push([toNode('peer-a', source), toNode('peer-b', target)]);
            }
        }
    }
    return pairs;
}

function toNode(id: string, coords: readonly number[]): VivaldiNodeData {
    return { id, coords: [...coords], err: 0.1, rttMs: 0 };
}
