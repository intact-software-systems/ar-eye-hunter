import { describe, expect, it } from 'vitest';
import { Coordinates, VivaldiNode } from '@shared-graph/graph/vivaldi-core.ts';

const SQRT_HALF = Math.SQRT1_2;

// Two fresh nodes both start at the origin, so the tie-break is the common
// first step between any pair, not an edge case. It used to be a jitter-and-
// retry loop whose only exit was the randomness happening to work.
describe('Vivaldi direction between collocated coordinates', () => {
    it('draws a unit vector from the injected source of randomness', () => {
        const here = new Coordinates([0, 0]);
        const remote = new Coordinates([0, 0]);

        const direction = here.computeDirectionality(remote, () => 1);

        expect(direction.values[0]).toBeCloseTo(SQRT_HALF, 12);
        expect(direction.values[1]).toBeCloseTo(SQRT_HALF, 12);
        expect(direction.norm()).toBeCloseTo(1, 12);
    });

    it('leaves the coordinates it was asked about untouched', () => {
        const here = new Coordinates([0, 0]);
        const remote = new Coordinates([0, 0]);

        here.computeDirectionality(remote, () => 1);

        expect(here.values).toEqual([0, 0]);
        expect(remote.values).toEqual([0, 0]);
    });

    // 0.5 maps to exactly 0, so every drawn component is zero and the draw
    // cannot separate the points. The old loop spun on this forever; the
    // fallback basis vector is what makes the function total.
    it('falls back to a basis vector when the draw is degenerate', () => {
        const here = new Coordinates([0, 0, 0]);
        const remote = new Coordinates([0, 0, 0]);

        expect(here.computeDirectionality(remote, () => 0.5).values).toEqual([1, 0, 0]);
    });

    // Previously an unbounded loop: an empty vector has norm 0 under every
    // branch, so no amount of jitter could ever separate it.
    it('rejects a zero-dimensional direction instead of spinning', () => {
        expect(() => new Coordinates([]).computeDirectionality(new Coordinates([])))
            .toThrow('Direction is undefined for zero-dimensional coordinates');
    });

    it('still uses the real difference when the coordinates are separated', () => {
        const here = new Coordinates([3, 0]);
        const remote = new Coordinates([0, 0]);

        // The random source would give [1, 0] here if it were consulted.
        expect(here.computeDirectionality(remote, () => 0.5).values).toEqual([1, 0]);
    });
});

describe('VivaldiNode construction', () => {
    // A zero-dimension node reached the same unbounded loop through update().
    it.each([
        { label: 'zero', dimensions: 0 },
        { label: 'negative', dimensions: -1 },
        { label: 'fractional', dimensions: 1.5 },
    ])('rejects $label dimensions', ({ dimensions }) => {
        expect(() => new VivaldiNode({ dimensions }))
            .toThrow('Vivaldi node dimensions must be an integer >= 1');
    });
});

describe('VivaldiNode.update from the origin', () => {
    // The step length is cc * weight * diffErr = 0.25 * 0.5 * 50, and nothing
    // else. The tie-break used to jitter the node's own coordinates on the way
    // past, so that jitter landed in the result and the step came out longer
    // than the algorithm calls for.
    it('moves exactly the computed step length', () => {
        const node = new VivaldiNode({ dimensions: 2, random: () => 1 });

        node.update({ id: 'peer', coords: [0, 0], err: 1.0, rttMs: 50 });

        expect(node.coords.norm()).toBeCloseTo(6.25, 12);
        expect(node.coords.values[0]).toBeCloseTo(6.25 * SQRT_HALF, 12);
        expect(node.coords.values[1]).toBeCloseTo(6.25 * SQRT_HALF, 12);
    });

    it('is reproducible under a fixed source of randomness', () => {
        const first = new VivaldiNode({ dimensions: 3, random: () => 0.75 });
        const second = new VivaldiNode({ dimensions: 3, random: () => 0.75 });
        const sample = { id: 'peer', coords: [0, 0, 0], err: 1.0, rttMs: 40 } as const;

        first.update(sample);
        second.update(sample);

        expect(first.coords.values).toEqual(second.coords.values);
    });

    // err: NaN leaves nextErr non-finite, and that guard sits after the
    // direction has been computed. While the tie-break mutated the node, a
    // rejection here had already moved it.
    it('does not move the node when a late guard rejects the sample', () => {
        const node = new VivaldiNode({ dimensions: 2, random: () => 1 });

        node.update({ id: 'peer', coords: [0, 0], err: Number.NaN, rttMs: 50 });

        expect(node.coords.values).toEqual([0, 0]);
        expect(node.myError).toBe(1.0);
    });
});
