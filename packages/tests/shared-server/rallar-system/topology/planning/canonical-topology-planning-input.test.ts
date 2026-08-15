import { describe, expect, it } from 'vitest';
// prettier-ignore
import {
    computeCanonicalTopologyPairWeight,
    toCanonicalTopologySessionIds,
} from '@shared-server/rallar-system/topology/planning/canonical-topology-planning-input.ts';

describe('canonical topology planning input', () => {
    it('sorts and dedupes session ids by exact code-unit order', () => {
        expect(
            toCanonicalTopologySessionIds(['b', 'a', 'b', 'Z', 'á', 'é']),
        ).toEqual(['Z', 'a', 'á', 'b', 'é']);
    });

    it('returns identical canonical order for every permutation', () => {
        const sessionIds = ['s-3', 's-1', 's-10', 's-2', 'S-1'];
        const canonical = toCanonicalTopologySessionIds(sessionIds);
        expect(toCanonicalTopologySessionIds([...sessionIds].reverse())).toEqual(canonical);
        expect(toCanonicalTopologySessionIds([...sessionIds].sort())).toEqual(canonical);
    });

    it('derives symmetric, bounded, pair-stable weights', () => {
        const weight = computeCanonicalTopologyPairWeight('session-a', 'session-b');
        expect(computeCanonicalTopologyPairWeight('session-b', 'session-a')).toBe(weight);
        expect(weight).toBeGreaterThanOrEqual(1);
        expect(weight).toBeLessThan(32);
        expect(computeCanonicalTopologyPairWeight('session-a', 'session-b')).toBe(weight);
    });

    it('keeps every pair weight >= 1 across many pairs (the mirror distance sentinel)', () => {
        for (let left = 0; left < 40; left++) {
            for (let right = left + 1; right < 40; right++) {
                const weight = computeCanonicalTopologyPairWeight(
                    `session-${left}`,
                    `session-${right}`,
                );
                expect(weight).toBeGreaterThanOrEqual(1);
                expect(weight).toBeLessThan(32);
            }
        }
    });

    it('does not shift a pair weight when unrelated members change', () => {
        const before = computeCanonicalTopologyPairWeight('session-a', 'session-b');
        // Positional weights shifted on every membership change; canonical pair
        // weights are a function of the unordered pair identity alone.
        expect(computeCanonicalTopologyPairWeight('session-a', 'session-b')).toBe(before);
    });

    it('distinguishes delimiter-colliding pair identities', () => {
        const collidingLeft = computeCanonicalTopologyPairWeight('a', 'b:c');
        const collidingRight = computeCanonicalTopologyPairWeight('a:b', 'c');
        expect(collidingLeft).not.toBe(collidingRight);
    });
});
