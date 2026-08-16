import { describe, expect, it } from 'vitest';
import { Coordinates } from '@shared-graph/graph/vivaldi-core.ts';

// Coordinates is the oracle that compute-predicted-rtt-ms.test.ts checks the
// optimized distance loop against, so the class certifying that function had no
// tests of its own. These pin the arithmetic, the three norms and the guards
// directly, before any change to the direction logic.
describe('Coordinates', () => {
    describe('construction and access', () => {
        it('copies the values it is given', () => {
            const input = [1, 2, 3];
            const coords = new Coordinates(input);

            input[0] = 99;

            expect(coords.values).toEqual([1, 2, 3]);
        });

        it('hands out a copy rather than the backing array', () => {
            const coords = new Coordinates([1, 2, 3]);

            coords.values[0] = 99;

            expect(coords.values).toEqual([1, 2, 3]);
        });

        // A clone that silently reverted to the default L2 norm would still
        // look correct in every test that does not override the norm.
        it('carries the config through clone', () => {
            const coords = new Coordinates([3, -4], { useL1: true });

            expect(coords.clone().norm()).toBe(7);
        });
    });

    describe('arithmetic', () => {
        it('adds and subtracts componentwise without mutating either operand', () => {
            const left = new Coordinates([1, 2]);
            const right = new Coordinates([10, 20]);

            expect(left.add(right).values).toEqual([11, 22]);
            expect(left.subtract(right).values).toEqual([-9, -18]);
            expect(left.values).toEqual([1, 2]);
            expect(right.values).toEqual([10, 20]);
        });

        it('scales componentwise', () => {
            expect(new Coordinates([1, -2, 0.5]).multiply(-2).values).toEqual([-2, 4, -1]);
        });

        // Every operation rebuilds from the receiver's config, so a result keeps
        // measuring itself the way its source did.
        it('carries the config through arithmetic', () => {
            const coords = new Coordinates([3, -4], { useL1: true });

            expect(coords.multiply(2).norm()).toBe(14);
            expect(coords.add(new Coordinates([0, 0])).norm()).toBe(7);
            expect(coords.subtract(new Coordinates([0, 0])).norm()).toBe(7);
        });

        it.each([
            { operation: 'add' },
            { operation: 'subtract' },
        ] as const)('rejects a dimension mismatch in $operation', ({ operation }) => {
            const two = new Coordinates([1, 2]);
            const three = new Coordinates([1, 2, 3]);

            expect(() => two[operation](three)).toThrow('Coordinate dimension mismatch: 2 !== 3');
            expect(() => three[operation](two)).toThrow('Coordinate dimension mismatch: 3 !== 2');
        });
    });

    describe('norms', () => {
        // One vector under all three norms: 5, 7 and 4 are distinct, so a norm
        // silently falling back to another branch cannot pass.
        it.each([
            { norm: 'L2 by default', cfg: {}, expected: 5 },
            { norm: 'L1 when configured', cfg: { useL1: true }, expected: 7 },
            { norm: 'L-infinity when configured', cfg: { useLInf: true }, expected: 4 },
            // Setting both is not an error; norm() tests L-infinity first, and
            // computePredictedRttMs mirrors that precedence.
            {
                norm: 'L-infinity ahead of L1 when both are set',
                cfg: { useL1: true, useLInf: true },
                expected: 4,
            },
        ])('measures $norm', ({ cfg, expected }) => {
            expect(new Coordinates([3, -4], cfg).norm()).toBe(expected);
        });

        // Vacuously zero under every branch, since each folds over no
        // components. This is what leaves a zero-dimension direction undefined.
        it.each([
            { norm: 'L2', cfg: {} },
            { norm: 'L1', cfg: { useL1: true } },
            { norm: 'L-infinity', cfg: { useLInf: true } },
        ])('measures an empty vector as zero under $norm', ({ cfg }) => {
            expect(new Coordinates([], cfg).norm()).toBe(0);
        });

        it.each([
            { norm: 'L2', cfg: {}, expected: 5 },
            { norm: 'L1', cfg: { useL1: true }, expected: 7 },
            { norm: 'L-infinity', cfg: { useLInf: true }, expected: 4 },
        ])('computes distance as the norm of the difference under $norm', ({ cfg, expected }) => {
            const here = new Coordinates([3, -4], cfg);
            const remote = new Coordinates([0, 0], cfg);

            expect(here.distance(remote)).toBe(expected);
            expect(remote.distance(here)).toBe(expected);
        });

        it('measures zero distance between identical coordinates', () => {
            const values = [3, -7, 11];

            expect(new Coordinates(values).distance(new Coordinates(values))).toBe(0);
        });
    });

    describe('isValid', () => {
        it.each([
            { label: 'NaN', values: [1, Number.NaN] },
            { label: 'positive infinity', values: [Number.POSITIVE_INFINITY, 1] },
            { label: 'negative infinity', values: [1, Number.NEGATIVE_INFINITY] },
        ])('rejects $label', ({ values }) => {
            expect(new Coordinates(values).isValid()).toBe(false);
        });

        it('accepts finite values including zero and negatives', () => {
            expect(new Coordinates([0, -1, 2.5]).isValid()).toBe(true);
        });

        // Vacuously true: there is no non-finite component to find. isValid is
        // therefore no guard against a zero-dimension vector.
        it('accepts an empty vector', () => {
            expect(new Coordinates([]).isValid()).toBe(true);
        });
    });

    // The collocated case is covered in vivaldi-direction.test.ts, which owns
    // the random tie-break.
    describe('computeDirectionality between separated coordinates', () => {
        // The difference is this minus remote, so the unit vector points from
        // the remote coordinate toward this one.
        it('points from the remote coordinate toward this one', () => {
            const here = new Coordinates([3, 0]);
            const remote = new Coordinates([0, 0]);

            expect(here.computeDirectionality(remote).values).toEqual([1, 0]);
            expect(remote.computeDirectionality(here).values).toEqual([-1, 0]);
        });

        it('leaves both coordinates untouched', () => {
            const here = new Coordinates([3, 4]);
            const remote = new Coordinates([0, 0]);

            here.computeDirectionality(remote);

            expect(here.values).toEqual([3, 4]);
            expect(remote.values).toEqual([0, 0]);
        });

        // Normalized by the configured norm rather than the Euclidean one, so
        // under L1 or L-infinity the result is a unit vector only in that metric.
        it.each([
            { norm: 'L2', cfg: {} },
            { norm: 'L1', cfg: { useL1: true } },
            { norm: 'L-infinity', cfg: { useLInf: true } },
        ])('returns a unit vector under $norm', ({ cfg }) => {
            const here = new Coordinates([3, -4], cfg);
            const remote = new Coordinates([0, 0], cfg);

            expect(here.computeDirectionality(remote).norm()).toBeCloseTo(1, 12);
        });
    });
});
