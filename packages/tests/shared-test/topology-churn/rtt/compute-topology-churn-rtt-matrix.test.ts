import { filterRtcRttMeasurementsForGroup } from '@shared-server/rallar-system/rtc-rtt/policy/rtc-rtt-measurement-policy.ts';
import type { ComputedRtcTopologyPlan } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import {
    computeTopologyChurnRttMatrix,
    computeTopologyChurnRttPairs,
    type TopologyChurnRttMatrixShape,
    type TopologyChurnRttPair
} from '@shared-test/black-box-runner/topology-churn/rtt/compute-topology-churn-rtt-matrix.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';

import {
    computeRtcTopologyFixturePlan,
    createRtcTopologyFixtureGroup,
    RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS
} from '../../../shared-server/rallar-system/topology/planning/rtc-topology-planning-fixtures.ts';
import { createRtcTopologyRttMeasurement } from '../../../shared-server/rallar-system/topology/rtc-topology-test-fixtures.ts';

type TopologyChurnLayout = Pick<RallarOverlayTopologySnapshot, 'activeSessionIds' | 'nextHopsBySessionId'>;

const ROOM_REF: GroupRef = { applicationId: 'topology-churn', workspaceId: 'workspace', groupId: 'rtt-room' };

/** An undirected layout from its links, its sessions in the order given. */
function toLayout(sessionIds: readonly string[], links: readonly (readonly [string, string])[]): TopologyChurnLayout {
    const nextHopsBySessionId: Record<string, string[]> = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, []]));
    for (const [left, right] of links) {
        nextHopsBySessionId[left].push(right);
        nextHopsBySessionId[right].push(left);
    }
    return { activeSessionIds: sessionIds, nextHopsBySessionId };
}

function toPair(sessionIdFrom: string, sessionIdTo: string): TopologyChurnRttPair {
    return { sessionIdFrom, sessionIdTo };
}

/** The fixture room of 8, formed without RTT by the real planner: a tree at the size-selected options. */
function formFixtureTreeOfEight() {
    const group = createRtcTopologyFixtureGroup(8);
    const formed = computeRtcTopologyFixturePlan({
        options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
        group,
        previous: undefined
    }).snapshot;
    expect(formed.topology).toBe('tree');
    const roomRef: GroupRef = {
        applicationId: group.group.applicationId,
        workspaceId: group.group.workspaceId,
        groupId: group.group.groupId
    };
    return { group, formed, roomRef };
}

/** A layout's links, each as `from|to` in canonical order. */
function toLinks(layout: Pick<RallarOverlayTopologySnapshot, 'nextHopsBySessionId'>): ReadonlySet<string> {
    return new Set(
        Object.entries(layout.nextHopsBySessionId).flatMap(([sessionId, nextHops]) =>
            nextHops.map((peerId) => sessionId < peerId ? `${sessionId}|${peerId}` : `${peerId}|${sessionId}`)
        )
    );
}

function countPairsBySessionId(pairs: readonly TopologyChurnRttPair[]): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const pair of pairs) {
        counts.set(pair.sessionIdFrom, (counts.get(pair.sessionIdFrom) ?? 0) + 1);
        counts.set(pair.sessionIdTo, (counts.get(pair.sessionIdTo) ?? 0) + 1);
    }
    return counts;
}

describe('computeTopologyChurnRttPairs', () => {
    it('every pair is canonical and passes the server\'s own reporting filter over the layout', () => {
        const { group, formed, roomRef } = formFixtureTreeOfEight();

        const pairs = computeTopologyChurnRttPairs({
            layout: formed,
            roomRef,
            reportingDegreeLimit: 5,
            reporterSessionIds: formed.activeSessionIds
        });
        const measurements = pairs.map((pair, index) => createRtcTopologyRttMeasurement({ ...pair, rttMs: 50, version: index + 1 }));

        // A tree of 8 has 7 links, and every session also measures rendezvous-selected peers beyond its links.
        expect(pairs.length).toBeGreaterThan(7);
        expect(pairs.every((pair) => pair.sessionIdFrom < pair.sessionIdTo)).toBe(true);
        expect(new Set(pairs.map((pair) => `${pair.sessionIdFrom}|${pair.sessionIdTo}`)).size).toBe(pairs.length);
        expect(filterRtcRttMeasurementsForGroup({
            group,
            rttMeasurements: measurements,
            overlaySnapshot: formed,
            degreeLimit: 5
        })).toEqual(measurements);
    });

    it('no session is in more pairs than the reporting limit', () => {
        // A star: the hub a has six links, but a limit of 2 lets it into two pairs only.
        const layout = toLayout(['a', 'b', 'c', 'd', 'e', 'f', 'g'], [
            ['a', 'b'],
            ['a', 'c'],
            ['a', 'd'],
            ['a', 'e'],
            ['a', 'f'],
            ['a', 'g']
        ]);

        const pairs = computeTopologyChurnRttPairs({
            layout,
            roomRef: ROOM_REF,
            reportingDegreeLimit: 2,
            reporterSessionIds: layout.activeSessionIds
        });

        expect(pairs.slice(0, 2)).toEqual([toPair('a', 'b'), toPair('a', 'c')]);
        expect(countPairsBySessionId(pairs).get('a')).toBe(2);
        expect(Math.max(...countPairsBySessionId(pairs).values())).toBeLessThanOrEqual(2);
        // Once the hub is full, the leaves pair with each other.
        expect(pairs.length).toBeGreaterThan(2);
    });

    it('no session is in more pairs than the reporting limit, also where it is the pair\'s second session', () => {
        // The same star with the hub z last in identifier order: z is the second session of every one of its pairs.
        const layout = toLayout(['a', 'b', 'c', 'd', 'e', 'f', 'z'], [
            ['z', 'a'],
            ['z', 'b'],
            ['z', 'c'],
            ['z', 'd'],
            ['z', 'e'],
            ['z', 'f']
        ]);

        const pairs = computeTopologyChurnRttPairs({
            layout,
            roomRef: ROOM_REF,
            reportingDegreeLimit: 2,
            reporterSessionIds: layout.activeSessionIds
        });

        expect(pairs.slice(0, 2)).toEqual([toPair('a', 'z'), toPair('b', 'z')]);
        expect(countPairsBySessionId(pairs).get('z')).toBe(2);
        expect(Math.max(...countPairsBySessionId(pairs).values())).toBeLessThanOrEqual(2);
    });

    it('takes every layout link first', () => {
        // A path given out of identifier order: d – a – c – b, with each session's next hops unsorted.
        const layout = toLayout(['d', 'c', 'b', 'a'], [['d', 'a'], ['a', 'c'], ['c', 'b']]);

        const pairs = computeTopologyChurnRttPairs({
            layout,
            roomRef: ROOM_REF,
            reportingDegreeLimit: 5,
            reporterSessionIds: layout.activeSessionIds
        });

        // Sessions in identifier order, each one's next hops sorted, canonical and de-duplicated: a's links to c and d,
        // then b's link to c; c's and d's links are already taken.
        expect(pairs.slice(0, 3)).toEqual([toPair('a', 'c'), toPair('a', 'd'), toPair('b', 'c')]);
        // Four sessions under a limit of 5: every other pair follows the links, so all six pairs are measured.
        expect(pairs.slice(3).map((pair) => `${pair.sessionIdFrom}|${pair.sessionIdTo}`).sort()).toEqual([
            'a|b',
            'b|d',
            'c|d'
        ]);
    });

    it('leaves out a pair whose canonical reporter has no socket', () => {
        // A path a – b – c – d, where c has no socket: the pair (c, d) is c's to report, the pair (b, c) is b's.
        const layout = toLayout(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);

        const pairs = computeTopologyChurnRttPairs({
            layout,
            roomRef: ROOM_REF,
            reportingDegreeLimit: 5,
            reporterSessionIds: ['a', 'b', 'd']
        });

        expect(pairs.slice(0, 2)).toEqual([toPair('a', 'b'), toPair('b', 'c')]);
        expect(pairs.filter((pair) => pair.sessionIdFrom === 'c')).toEqual([]);
        expect(pairs.map((pair) => `${pair.sessionIdFrom}|${pair.sessionIdTo}`).sort()).toEqual([
            'a|b',
            'a|c',
            'a|d',
            'b|c',
            'b|d'
        ]);
    });
});

describe('computeTopologyChurnRttMatrix', () => {
    // A path a – b – c; the pair (a, c) is not a link.
    const layout = toLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const pairs = [toPair('a', 'b'), toPair('a', 'c'), toPair('b', 'c')];

    it('uniform reports one value for every pair', () => {
        expect(computeTopologyChurnRttMatrix({ pairs, layout, shape: 'uniform' })).toEqual([
            { sessionIdFrom: 'a', sessionIdTo: 'b', rttMs: 50 },
            { sessionIdFrom: 'a', sessionIdTo: 'c', rttMs: 50 },
            { sessionIdFrom: 'b', sessionIdTo: 'c', rttMs: 50 }
        ]);
    });

    it('skewed makes layout links slow and other pairs fast', () => {
        expect(computeTopologyChurnRttMatrix({ pairs, layout, shape: 'skewed' })).toEqual([
            { sessionIdFrom: 'a', sessionIdTo: 'b', rttMs: 120 },
            { sessionIdFrom: 'a', sessionIdTo: 'c', rttMs: 10 },
            { sessionIdFrom: 'b', sessionIdTo: 'c', rttMs: 120 }
        ]);
    });
});

describe('the RTT matrix against the real planner', () => {
    /** Reports the matrix over the previous tree of the fixture room of 8, then replans it as a claimed RTT refresh does. */
    function replanWithMatrix(
        previous: RallarOverlayTopologySnapshot,
        shape: TopologyChurnRttMatrixShape
    ): ComputedRtcTopologyPlan {
        const { group, roomRef } = formFixtureTreeOfEight();
        const pairs = computeTopologyChurnRttPairs({
            layout: previous,
            roomRef,
            reportingDegreeLimit: 5,
            reporterSessionIds: previous.activeSessionIds
        });
        const measurements = computeTopologyChurnRttMatrix({ pairs, layout: previous, shape }).map((report, index) =>
            createRtcTopologyRttMeasurement({ ...report, version: index + 1 })
        );
        const planned = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group,
            previous,
            planningIntent: 'full-rebuild',
            rttMeasurements: measurements
        });
        expect(planned.snapshot.topology).toBe('tree');
        return planned;
    }

    /** The tree the uniform matrix leaves the fixture room with, as the measurement's uniform phase does. */
    function refineWithUniformMatrix(): RallarOverlayTopologySnapshot {
        return replanWithMatrix(formFixtureTreeOfEight().formed, 'uniform').snapshot;
    }

    it('the uniform matrix rebuilds the fixture\'s no-RTT tree of 8 once, as a refinement', () => {
        // The planner forms a room without RTT as a nearest-weight tree, not a shallowest one: this one is 5 hops
        // across, and a rebuild over equal RTT is 3 hops across, 100 ms shorter at 50 ms a link. That gain is more
        // than a quarter of the kept 250 ms, so even a uniform matrix refines a tree formed without RTT.
        const { formed } = formFixtureTreeOfEight();
        const planned = replanWithMatrix(formed, 'uniform');

        expect(planned.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
        expect(planned.snapshot.nextHopsBySessionId).not.toEqual(formed.nextHopsBySessionId);
    });

    it('the uniform matrix keeps the tree once it is refined', () => {
        const refined = refineWithUniformMatrix();
        const planned = replanWithMatrix(refined, 'uniform');

        expect(planned.derivation).toEqual({ method: 'incremental' });
        expect(planned.snapshot.nextHopsBySessionId).toEqual(refined.nextHopsBySessionId);
    });

    it('the skewed matrix makes the planner rebuild the tree as a refinement', () => {
        // Even a flat matrix refines this tree (see above) and keeps some of its links; the skew makes every one of the
        // formed tree's links the slowest, so the rebuild keeps none of them.
        const { formed } = formFixtureTreeOfEight();
        const planned = replanWithMatrix(formed, 'skewed');

        expect(planned.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
        expect([...toLinks(planned.snapshot)].filter((link) => toLinks(formed).has(link))).toEqual([]);
    });

    it('the skewed matrix makes the planner rebuild, as a refinement, the tree the uniform matrix keeps', () => {
        // The measurement's order: the uniform phase leaves a refined tree the uniform matrix keeps, and only the skew
        // of its links rebuilds it.
        const refined = refineWithUniformMatrix();
        const planned = replanWithMatrix(refined, 'skewed');

        expect(planned.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
        expect(planned.snapshot.nextHopsBySessionId).not.toEqual(refined.nextHopsBySessionId);
    });
});
