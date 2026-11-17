import type { ComputedRtcTopologyPlan } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import { resolveTopologyChurnLeaderCandidate } from '@shared-test/black-box-runner/topology-churn/phases/resolve-topology-churn-leader-candidate.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { describe, expect, it } from 'vitest';

import {
    computeRtcTopologyFixturePlan,
    createRtcTopologyFixtureGroup,
    RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS
} from '../../../shared-server/rallar-system/topology/planning/rtc-topology-planning-fixtures.ts';
import { toRtcTopologyGroupWithDirector } from '../../../shared-server/rallar-system/topology/rtc-topology-test-fixtures.ts';

type TopologyChurnLayout = Pick<RallarOverlayTopologySnapshot, 'activeSessionIds' | 'nextHopsBySessionId'>;

/** An undirected layout from its links, its sessions in the order given. */
function toLayout(sessionIds: readonly string[], links: readonly (readonly [string, string])[]): TopologyChurnLayout {
    const nextHopsBySessionId: Record<string, string[]> = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, []]));
    for (const [left, right] of links) {
        nextHopsBySessionId[left].push(right);
        nextHopsBySessionId[right].push(left);
    }
    return { activeSessionIds: sessionIds, nextHopsBySessionId };
}

describe('resolveTopologyChurnLeaderCandidate', () => {
    it('picks the session farthest from some other session', () => {
        // m – k – c – z: m and z are three hops from each other, k and c at most two from anyone; z leads.
        const layout = toLayout(['c', 'k', 'm', 'z'], [['m', 'k'], ['k', 'c'], ['c', 'z']]);

        expect(resolveTopologyChurnLeaderCandidate({ layout, leaderSessionId: 'z' })).toBe('m');
    });

    it('never picks the leader', () => {
        // a – b – c: a and c are equally far from each other, and a comes first, but a leads.
        const layout = toLayout(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);

        expect(resolveTopologyChurnLeaderCandidate({ layout, leaderSessionId: 'a' })).toBe('c');
    });

    it('breaks a tie by identifier order', () => {
        // A star: every leaf is two hops from another leaf. Code-unit order puts peer-10 before peer-2.
        const layout = toLayout(['hub', 'peer-2', 'peer-3', 'peer-10'], [
            ['hub', 'peer-2'],
            ['hub', 'peer-3'],
            ['hub', 'peer-10']
        ]);

        expect(resolveTopologyChurnLeaderCandidate({ layout, leaderSessionId: null })).toBe('peer-10');
    });

    it('answers null when only the leader is present', () => {
        expect(resolveTopologyChurnLeaderCandidate({ layout: toLayout(['solo'], []), leaderSessionId: 'solo' }))
            .toBeNull();
        expect(resolveTopologyChurnLeaderCandidate({ layout: toLayout([], []), leaderSessionId: null })).toBeNull();
    });
});

describe('resolveTopologyChurnLeaderCandidate against the real planner', () => {
    const leaderRooting = { method: 'rebuilt', reason: 'leader-rooting' };

    it('each appointed candidate makes the real planner rebuild a led tree of 12 for leader rooting, three times in a row', () => {
        expect(computeThreeAppointmentDerivations(12)).toEqual([leaderRooting, leaderRooting, leaderRooting]);
    });

    it('the real planner rebuilds a led tree of 8 for leader rooting at the second of three appointed candidates only', () => {
        // The planner's no-RTT tree is a nearest-weight tree, not a breadth-first one: rooted at the candidate it can
        // be as deep from the candidate as the kept tree is, and then the leader rule keeps the tree. Of the three
        // candidates of this room of 8 at degree limit 5, only the second one's rooted tree is shallower.
        expect(computeThreeAppointmentDerivations(8)).toEqual([
            { method: 'incremental' },
            leaderRooting,
            { method: 'incremental' }
        ]);
    });
});

/**
 * Forms the room without a leader, then appoints the candidate of the current layout three times, each against the
 * layout the appointment before it produced, as the reshape measurement's quiet leader phase does.
 */
function computeThreeAppointmentDerivations(memberCount: number): readonly ComputedRtcTopologyPlan['derivation'][] {
    const group = createRtcTopologyFixtureGroup(memberCount);
    let layout = computeRtcTopologyFixturePlan({
        options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
        group,
        previous: undefined
    }).snapshot;
    let leaderSessionId: string | null = null;
    const derivations: ComputedRtcTopologyPlan['derivation'][] = [];
    for (let appointment = 1; appointment <= 3; appointment += 1) {
        const candidate = resolveTopologyChurnLeaderCandidate({ layout, leaderSessionId });
        if (candidate === null) {
            throw new Error(`The layout before appointment ${appointment} has no candidate.`);
        }
        const planned = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: toRtcTopologyGroupWithDirector(group, candidate),
            previous: layout
        });
        expect(planned.snapshot.topology).toBe('tree');
        derivations.push(planned.derivation);
        layout = planned.snapshot;
        leaderSessionId = candidate;
    }
    return derivations;
}
