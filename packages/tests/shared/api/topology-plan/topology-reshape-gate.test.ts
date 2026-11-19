import { describe, expect, it } from 'vitest';

import { toMergedHeldTopologyReshapeReasons } from '@shared/api/topology-plan/topology-reshape-gate.ts';

describe('toMergedHeldTopologyReshapeReasons', () => {
    it('merges both lists into the canonical order without duplicates', () => {
        expect(toMergedHeldTopologyReshapeReasons(['leader-rooting'], ['kind-change'])).toEqual([
            'kind-change',
            'leader-rooting'
        ]);
        expect(toMergedHeldTopologyReshapeReasons(['kind-change'], ['kind-change', 'leader-rooting'])).toEqual([
            'kind-change',
            'leader-rooting'
        ]);
    });

    it('keeps one list as it is when the other is empty, and two empty lists merge to none', () => {
        expect(toMergedHeldTopologyReshapeReasons([], ['leader-rooting'])).toEqual(['leader-rooting']);
        expect(toMergedHeldTopologyReshapeReasons(['kind-change'], [])).toEqual(['kind-change']);
        expect(toMergedHeldTopologyReshapeReasons([], [])).toEqual([]);
    });
});
