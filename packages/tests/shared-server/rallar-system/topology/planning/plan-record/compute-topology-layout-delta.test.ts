import { describe, expect, it } from 'vitest';

import { computeTopologyLayoutDelta } from '@shared-server/rallar-system/topology/planning/plan-record/compute-topology-layout-delta.ts';
import type { TopologyLayoutEdges } from '@shared-server/rallar-system/topology/planning/plan-record/compute-topology-layout-delta.ts';
import { EMPTY_TOPOLOGY_LAYOUT_DELTA } from '../../../../../shared/api/topology-plan/empty-topology-layout-delta.ts';

/** Lists every edge from both ends, as the planner publishes next hops. */
function createLayout(sessionIds: readonly string[], edges: readonly (readonly [string, string])[]): TopologyLayoutEdges {
    const nextHopsBySessionId: Record<string, string[]> = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, []]));
    for (const [from, to] of edges) {
        nextHopsBySessionId[from]?.push(to);
        nextHopsBySessionId[to]?.push(from);
    }
    return { activeSessionIds: sessionIds, nextHopsBySessionId };
}

describe('computeTopologyLayoutDelta', () => {
    it('counts every member of a first layout as joined and none as changed', () => {
        const next = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);

        expect(computeTopologyLayoutDelta(null, next)).toEqual({ ...EMPTY_TOPOLOGY_LAYOUT_DELTA, joinedSessionCount: 3 });
    });

    it('a joiner\'s edges change the members that accept it and reroute nobody', () => {
        const previous = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
        const next = createLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            joinedSessionCount: 1,
            changedSessionCount: 1,
            acceptingSessionCount: 1,
            maxJoinerEdgesPerSession: 1
        });
    });

    it('a leaver\'s dropped edges change its neighbours and reroute nobody', () => {
        const previous = createLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
        const next = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            leftSessionCount: 1,
            changedSessionCount: 1
        });
    });

    it('an edge added between two of a leaver\'s neighbours is a repair, not a reroute', () => {
        // The hub leaves; its three dependants are joined to each other instead.
        const previous = createLayout(['h', 'a', 'b', 'c'], [['h', 'a'], ['h', 'b'], ['h', 'c']]);
        const next = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            leftSessionCount: 1,
            changedSessionCount: 3
        });
    });

    it('an edge added between a leaver\'s neighbour and a member the leaver never touched is a repair, not a reroute', () => {
        // x leaves from the end of the chain; c depended on it and gains a new upstream in a, which x never touched.
        const previous = createLayout(['a', 'b', 'c', 'x'], [['a', 'b'], ['b', 'c'], ['c', 'x']]);
        const next = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            leftSessionCount: 1,
            changedSessionCount: 2
        });
    });

    it('an edge added between two members the leaver never touched reroutes both', () => {
        // x leaves from the end of the chain; only d depended on it, yet a and c gain an edge.
        const previous = createLayout(['a', 'b', 'c', 'd', 'x'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'x']]);
        const next = createLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'c']]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            leftSessionCount: 1,
            changedSessionCount: 3,
            reroutedSessionCount: 2
        });
    });

    it('an edge removed between two staying members reroutes both', () => {
        const previous = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['a', 'c']]);
        const next = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            changedSessionCount: 2,
            reroutedSessionCount: 2
        });
    });

    it('counts the members that accept joiners and the most joiner edges one of them accepts', () => {
        // The edge between two joiners belongs to no staying member.
        const previous = createLayout(['a', 'b'], [['a', 'b']]);
        const next = createLayout(['a', 'b', 'j1', 'j2', 'j3'], [
            ['a', 'b'],
            ['a', 'j1'],
            ['a', 'j2'],
            ['b', 'j3'],
            ['j1', 'j2']
        ]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            joinedSessionCount: 3,
            changedSessionCount: 2,
            acceptingSessionCount: 2,
            maxJoinerEdgesPerSession: 2
        });
    });

    it('an identical layout has an empty delta', () => {
        const layout = createLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);

        expect(computeTopologyLayoutDelta(layout, layout)).toEqual(EMPTY_TOPOLOGY_LAYOUT_DELTA);
    });

    it('a join into a complete graph reroutes nobody', () => {
        // The planner's "star": every member keeps its edges and gains one to the joiner.
        const previous = createLayout(['a', 'b', 'c'], [['a', 'b'], ['a', 'c'], ['b', 'c']]);
        const next = createLayout(['a', 'b', 'c', 'd'], [
            ['a', 'b'],
            ['a', 'c'],
            ['b', 'c'],
            ['a', 'd'],
            ['b', 'd'],
            ['c', 'd']
        ]);

        expect(computeTopologyLayoutDelta(previous, next)).toEqual({
            ...EMPTY_TOPOLOGY_LAYOUT_DELTA,
            joinedSessionCount: 1,
            changedSessionCount: 3,
            acceptingSessionCount: 3,
            maxJoinerEdgesPerSession: 1
        });
    });
});
