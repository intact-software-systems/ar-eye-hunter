import { describe, expect, it } from 'vitest';

import {
    isSameGroupLayoutIdentity,
    resolveGroupLayoutRole,
    toGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

function identity(overrides: Partial<GroupLayoutIdentity> = {}): GroupLayoutIdentity {
    return {
        groupRevision: 4,
        presenceRevision: 9,
        version: 2,
        state: 'active',
        ...overrides
    };
}

describe('toGroupLayoutIdentity', () => {
    it('flattens the causal tuple, version and state', () => {
        expect(toGroupLayoutIdentity({
            sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 9 },
            version: 2,
            state: 'active'
        })).toEqual(identity());
    });
});

describe('isSameGroupLayoutIdentity', () => {
    // A version comparison alone is not a safe test: the planner reuses the
    // previous version for the removed tombstone (product decision 29).
    it('distinguishes a tombstone from the active layout at the same tuple', () => {
        expect(isSameGroupLayoutIdentity(identity(), identity())).toBe(true);
        expect(isSameGroupLayoutIdentity(identity(), identity({ state: 'removed' }))).toBe(false);
        expect(isSameGroupLayoutIdentity(identity(), identity({ version: 3 }))).toBe(false);
    });
});

describe('resolveGroupLayoutRole', () => {
    it('classifies any publication as planned while nothing is accepted', () => {
        expect(resolveGroupLayoutRole({ publication: identity(), accepted: undefined })).toBe('planned');
    });

    it.each([
        {
            label: 'a re-delivered accepted layout as accepted',
            publication: identity(),
            role: 'accepted'
        },
        {
            label: 'a newer publication as planned',
            publication: identity({ groupRevision: 5, presenceRevision: 9, version: 3 }),
            role: 'planned'
        },
        {
            label: 'an older publication as superseded',
            publication: identity({ groupRevision: 3, presenceRevision: 8, version: 1 }),
            role: 'superseded'
        },
        {
            label: 'a causally incomparable publication explicitly',
            publication: identity({ groupRevision: 5, presenceRevision: 8 }),
            role: 'incomparable'
        },
        {
            label: 'the accepted layout tombstone as the newer fact',
            publication: identity({ state: 'removed' }),
            role: 'planned'
        }
    ])('classifies $label', (row) => {
        expect(resolveGroupLayoutRole({ publication: row.publication, accepted: identity() }))
            .toBe(row.role);
    });

    it('classifies a stale active copy arriving after the tombstone as superseded', () => {
        expect(resolveGroupLayoutRole({
            publication: identity(),
            accepted: identity({ state: 'removed' })
        })).toBe('superseded');
    });

    it('compares the tuple before the version', () => {
        expect(resolveGroupLayoutRole({
            publication: identity({ groupRevision: 5, version: 1 }),
            accepted: identity()
        })).toBe('planned');
    });
});
