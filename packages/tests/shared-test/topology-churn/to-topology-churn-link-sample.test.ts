import { toTopologyChurnLinkSample } from '@shared-test/black-box-runner/topology-churn/to-topology-churn-link-sample.ts';
import { describe, expect, it } from 'vitest';

const MESH: Parameters<typeof toTopologyChurnLinkSample>[0] = {
    sourceGroupStateCausalRevision: { groupRevision: 7, presenceRevision: 3 },
    version: 4,
    state: 'active',
    topology: 'mesh',
    activeSessionIds: ['session-a', 'session-b', 'session-c', 'session-d'],
    nextHopsBySessionId: {
        'session-a': ['session-b', 'session-c'],
        'session-b': ['session-a', 'session-c'],
        'session-c': ['session-a', 'session-b', 'session-d'],
        'session-d': ['session-c']
    }
};

describe('toTopologyChurnLinkSample', () => {
    it('counts the members of a mesh that hold fewer links than the mesh parameter', () => {
        // Links a 2, b 2, c 3, d 1: under 2 only d; under 3 a, b and d.
        expect(toTopologyChurnLinkSample(MESH, 2)).toEqual({
            layout: { groupRevision: 7, presenceRevision: 3, version: 4, state: 'active' },
            underLinkedMemberCount: 1
        });
        expect(toTopologyChurnLinkSample(MESH, 3)?.underLinkedMemberCount).toBe(3);
    });

    it('counts a member the layout lists without next hops', () => {
        const withUnlinkedMember = { ...MESH, activeSessionIds: [...MESH.activeSessionIds, 'session-e'] };

        // session-e has no entry in the next hops: no link, so under 2 with session-d.
        expect(toTopologyChurnLinkSample(withUnlinkedMember, 2)?.underLinkedMemberCount).toBe(2);
    });

    it('takes no sample of a star or a tree', () => {
        // The mesh parameter promises a member its links only in a mesh.
        expect(toTopologyChurnLinkSample({ ...MESH, topology: 'tree' }, 2)).toBeNull();
        expect(toTopologyChurnLinkSample({ ...MESH, topology: 'star' }, 2)).toBeNull();
    });
});
