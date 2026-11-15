import { describe, expect, it } from 'vitest';

import { decodeRtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/decode-rtc-topology-publication.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import { createGroupRef, createPublication, createTopologySnapshot } from '../rtc-topology-repository-test-fixtures.ts';
import { createRtcTopologyPublicationPlan } from '../rtc-topology-test-fixtures.ts';

const GROUP_REF = createGroupRef();

/** The tombstone a removal publishes: the layout's members with no edges left. */
function createRemovedSnapshot(): RallarOverlayTopologySnapshot {
    const active = createTopologySnapshot(GROUP_REF, 2);
    return {
        ...active,
        state: 'removed',
        nextHopsBySessionId: Object.fromEntries(active.activeSessionIds.map((sessionId) => [sessionId, []]))
    };
}

describe('decodeRtcTopologyPublication', () => {
    it('accepts an active layout with its plan and a removed layout without one', () => {
        const active = createPublication(createTopologySnapshot(GROUP_REF, 2), 'work-active');
        const removed = createPublication(createRemovedSnapshot(), 'work-removed');

        expect(decodeRtcTopologyPublication(active, GROUP_REF).right).toEqual(active);
        expect(decodeRtcTopologyPublication(removed, GROUP_REF).right).toEqual(removed);
    });

    it('refuses a publication without a plan', () => {
        const { plan: _plan, ...withoutPlan } = createPublication(createTopologySnapshot(GROUP_REF, 2), 'work-1');

        expect(decodeRtcTopologyPublication(withoutPlan, GROUP_REF).left).toBe('RTC topology publication fields are invalid');
    });

    it('refuses a plan on a removed layout', () => {
        const removed = createPublication(createRemovedSnapshot(), 'work-1');
        const plan = createRtcTopologyPublicationPlan(createTopologySnapshot(GROUP_REF, 2));

        expect(decodeRtcTopologyPublication({ ...removed, plan }, GROUP_REF).left)
            .toBe('RTC topology publication plan must be null exactly when its layout is removed');
    });

    it('refuses a null plan on an active layout', () => {
        const active = createPublication(createTopologySnapshot(GROUP_REF, 2), 'work-1');

        expect(decodeRtcTopologyPublication({ ...active, plan: null }, GROUP_REF).left)
            .toBe('RTC topology publication plan must be null exactly when its layout is removed');
    });

    it('refuses a plan that is not a plan record', () => {
        const active = createPublication(createTopologySnapshot(GROUP_REF, 2), 'work-1');

        expect(decodeRtcTopologyPublication({ ...active, plan: { ...active.plan, causes: ['unknown'] } }, GROUP_REF).left)
            .toBe('Topology plan record causes must be known, unique and in canonical order');
    });
});
