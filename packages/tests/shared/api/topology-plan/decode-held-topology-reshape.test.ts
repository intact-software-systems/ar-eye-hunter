import { describe, expect, it } from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeHeldTopologyReshape } from '@shared/api/topology-plan/decode-held-topology-reshape.ts';

const HELD = { wantedReasons: ['kind-change', 'leader-rooting'], opensAtEpochMs: 1_795_060_154_711 };

describe('decodeHeldTopologyReshape', () => {
    it('round-trips a held reshape, and one whose gate was never closed', () => {
        expect(decodeHeldTopologyReshape(HELD).right).toEqual(HELD);
        expect(decodeHeldTopologyReshape({ wantedReasons: ['leader-rooting'], opensAtEpochMs: 0 }).right)
            .toEqual({ wantedReasons: ['leader-rooting'], opensAtEpochMs: 0 });
    });

    it.each<[string, ApiJsonValue]>([
        ['no wanted reason', { ...HELD, wantedReasons: [] }],
        ['a reason the gate does not hold', { ...HELD, wantedReasons: ['kind-change', 'refinement'] }],
        ['a duplicate reason', { ...HELD, wantedReasons: ['kind-change', 'kind-change'] }],
        ['reasons out of order', { ...HELD, wantedReasons: ['leader-rooting', 'kind-change'] }],
        ['reasons that are no list', { ...HELD, wantedReasons: 'kind-change' }],
        ['a null opening instant', { ...HELD, opensAtEpochMs: null }],
        ['a negative opening instant', { ...HELD, opensAtEpochMs: -1 }],
        ['a fractional opening instant', { ...HELD, opensAtEpochMs: 1.5 }],
        ['a missing opening instant', { wantedReasons: ['kind-change'] }],
        ['an unknown key', { ...HELD, intervalMs: 15_000 }],
        ['a value that is no object', 'kind-change'],
        ['null', null]
    ])('refuses %s', (_label, value) => {
        expect(decodeHeldTopologyReshape(value).left).toEqual(expect.any(String));
    });
});
