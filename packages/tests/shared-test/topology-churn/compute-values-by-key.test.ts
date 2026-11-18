import { computeValuesByKey } from '@shared-test/black-box-runner/topology-churn/compute-values-by-key.ts';
import { describe, expect, it } from 'vitest';

describe('computeValuesByKey', () => {
    it('names every key once with its count, a key that counts nothing at zero', () => {
        const words = ['a', 'bb', 'cc', 'ddd'];

        const counts = computeValuesByKey(
            ['one', 'two', 'four'] as const,
            (key) => words.filter((word) => word.length === { one: 1, two: 2, four: 4 }[key]).length
        );

        expect(counts).toEqual({ one: 1, two: 2, four: 0 });
    });

    it('maps each key to any value, not only a count', () => {
        const words = ['a', 'bb', 'cc', 'ddd'];

        const firstWords = computeValuesByKey(
            ['one', 'two', 'four'] as const,
            (key) => words.find((word) => word.length === { one: 1, two: 2, four: 4 }[key]) ?? null
        );

        // A key whose value is absent keeps its place with that value.
        expect(firstWords).toEqual({ one: 'a', two: 'bb', four: null });
    });
});
