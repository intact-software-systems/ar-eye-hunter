import type { TopologyChurnPromotionSighting } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-report.ts';
import { resolveNewPromotionSighting } from '@shared-test/black-box-runner/topology-churn/resolve-new-promotion-sighting.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { describe, expect, it } from 'vitest';

function toLayout(version: number): GroupLayoutIdentity {
    return { groupRevision: version, presenceRevision: 1, version, state: 'active' };
}

const FIRST: TopologyChurnPromotionSighting = { layout: toLayout(1), firstSeenAtEpochMs: 1_000 };

describe('resolveNewPromotionSighting', () => {
    it('records a layout identity not seen before with the instant it was read', () => {
        expect(resolveNewPromotionSighting({ sightings: [FIRST], acceptedLayout: toLayout(2), seenAtEpochMs: 1_250 }))
            .toEqual({ layout: toLayout(2), firstSeenAtEpochMs: 1_250 });
    });

    it('records nothing for an identity already seen, so the first sighting keeps its instant', () => {
        expect(resolveNewPromotionSighting({ sightings: [FIRST], acceptedLayout: toLayout(1), seenAtEpochMs: 9_000 }))
            .toBeNull();
    });

    it('treats the same tuple in another state as a different identity', () => {
        const removed: GroupLayoutIdentity = { ...toLayout(1), state: 'removed' };

        expect(resolveNewPromotionSighting({ sightings: [FIRST], acceptedLayout: removed, seenAtEpochMs: 1_500 }))
            .toEqual({ layout: removed, firstSeenAtEpochMs: 1_500 });
    });

    it('records nothing while the room has accepted no layout', () => {
        expect(resolveNewPromotionSighting({ sightings: [], acceptedLayout: null, seenAtEpochMs: 500 })).toBeNull();
    });
});
