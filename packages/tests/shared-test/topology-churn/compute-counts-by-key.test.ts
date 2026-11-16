import { computeCountsByKey } from '@shared-test/black-box-runner/topology-churn/compute-counts-by-key.ts';
import { describe, expect, it } from 'vitest';

describe('computeCountsByKey', () => {
    it('names every key once with its count, a key that counts nothing at zero', () => {
        const words = ['a', 'bb', 'cc', 'ddd'];

        const counts = computeCountsByKey(
            ['one', 'two', 'four'] as const,
            (key) => words.filter((word) => word.length === { one: 1, two: 2, four: 4 }[key]).length
        );

        expect(counts).toEqual({ one: 1, two: 2, four: 0 });
    });
});
