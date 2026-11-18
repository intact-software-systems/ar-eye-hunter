import { describe, expect, it } from 'vitest';

import { computeLongestHopPath } from '@shared-server/rallar-system/topology/planning/plan-record/compute-longest-hop-path.ts';

describe('computeLongestHopPath', () => {
    it('a chain of four is three hops', () => {
        expect(computeLongestHopPath({
            activeSessionIds: ['a', 'b', 'c', 'd'],
            nextHopsBySessionId: { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'] }
        })).toBe(3);
    });

    it('a complete graph is one hop', () => {
        expect(computeLongestHopPath({
            activeSessionIds: ['a', 'b', 'c'],
            nextHopsBySessionId: { a: ['b', 'c'], b: ['a', 'c'], c: ['a', 'b'] }
        })).toBe(1);
    });

    it('a lone member is zero hops', () => {
        expect(computeLongestHopPath({ activeSessionIds: ['a'], nextHopsBySessionId: { a: [] } })).toBe(0);
    });

    it('takes the longest path of a layout in two parts', () => {
        expect(computeLongestHopPath({
            activeSessionIds: ['a', 'b', 'c', 'd', 'e'],
            nextHopsBySessionId: { a: ['b'], b: ['a', 'c'], c: ['b'], d: ['e'], e: ['d'] }
        })).toBe(2);
    });
});
