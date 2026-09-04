import { describe, expect, it } from 'vitest';

import {
    isSameGroupActivationSeries,
    type GroupActivationSeries
} from '@shared/api/group-lifecycle/activation-status/is-same-group-activation-series.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';

const carryingLayout: GroupLayoutIdentity = {
    groupRevision: 7,
    presenceRevision: 3,
    version: 2,
    state: 'active'
};

const series: GroupActivationSeries = {
    formationEpoch: 4,
    coverageBasisLayoutIdentity: carryingLayout
};

describe('group activation series', () => {
    it('accepts a status naming the same epoch and basis', () => {
        expect(isSameGroupActivationSeries(series, { ...series })).toBe(true);
    });

    it('rejects a status whose basis was replaced', () => {
        expect(isSameGroupActivationSeries(series, {
            formationEpoch: 4,
            coverageBasisLayoutIdentity: { ...carryingLayout, version: 3 }
        })).toBe(false);
    });

    // The reconfigure hold landing: the epoch advances while the accepted
    // layout identity is retained, so a basis-only comparison would carry the
    // spent series' band into the live one.
    it('rejects a status from a spent epoch on an unchanged basis', () => {
        expect(isSameGroupActivationSeries(series, {
            formationEpoch: 5,
            coverageBasisLayoutIdentity: carryingLayout
        })).toBe(false);
    });

    it('separates two layouts differing only in state', () => {
        expect(isSameGroupActivationSeries(series, {
            formationEpoch: 4,
            coverageBasisLayoutIdentity: { ...carryingLayout, state: 'removed' }
        })).toBe(false);
    });
});
