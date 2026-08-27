import { describe, expect, it } from 'vitest';

import { computeExpectedLayoutFence } from '@shared/api/group-lifecycle/compute-expected-layout-fence.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

const LAYOUT: GroupLayoutIdentity = {
    groupRevision: 4,
    presenceRevision: 9,
    version: 2,
    state: 'active'
};

describe('computeExpectedLayoutFence', () => {
    it('matches only the exact epoch and identity', () => {
        expect(computeExpectedLayoutFence({
            expectedFormationEpoch: 3,
            expectedLayout: LAYOUT,
            currentFormationEpoch: 3,
            currentPlannedLayout: LAYOUT
        })).toBe('match');
    });

    it('reads stale-epoch before consulting the layout at all', () => {
        expect(computeExpectedLayoutFence({
            expectedFormationEpoch: 2,
            expectedLayout: LAYOUT,
            currentFormationEpoch: 3,
            currentPlannedLayout: undefined
        })).toBe('stale-epoch');
    });

    it('reads no-planned-layout when nothing is stored', () => {
        expect(computeExpectedLayoutFence({
            expectedFormationEpoch: 3,
            expectedLayout: LAYOUT,
            currentFormationEpoch: 3,
            currentPlannedLayout: undefined
        })).toBe('no-planned-layout');
    });

    // Any non-identical current plan — newer, incomparable, or the named
    // layout's own tombstone — means the layout the caller waited for is no
    // longer the current plan (product decision 32).
    it.each([
        { label: 'a newer plan', current: { ...LAYOUT, groupRevision: 5, version: 3 } },
        { label: 'an incomparable plan', current: { ...LAYOUT, groupRevision: 5, presenceRevision: 8 } },
        { label: 'the named layout tombstone', current: { ...LAYOUT, state: 'removed' as const } }
    ])('reads planned-layout-superseded for $label', (row) => {
        expect(computeExpectedLayoutFence({
            expectedFormationEpoch: 3,
            expectedLayout: LAYOUT,
            currentFormationEpoch: 3,
            currentPlannedLayout: row.current
        })).toBe('planned-layout-superseded');
    });
});
