import { computeNoRttTopologyNextHops } from '@shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts';
import { computeTopologyChurnDrift } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-drift.ts';
import { describe, expect, it } from 'vitest';

const SESSIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter) => `session-${letter}`);

/** session-a – session-b – … end to end, one hop fewer than there are sessions. */
function toChain(sessionIds: readonly string[]): Readonly<Record<string, readonly string[]>> {
    return Object.fromEntries(
        sessionIds.map((sessionId, index) => [
            sessionId,
            [sessionIds[index - 1], sessionIds[index + 1]].filter(isSessionId)
        ])
    );
}

function isSessionId(sessionId: string | undefined): sessionId is string {
    return sessionId !== undefined;
}

describe('computeTopologyChurnDrift', () => {
    it('measures how many hops a chain is longer than a fresh no-RTT tree for the same members', () => {
        // With degree limit 3 and leader session-a the planner's no-RTT tree over these eight sessions is four hops deep.
        expect(
            computeTopologyChurnDrift({
                layout: {
                    topology: 'tree',
                    activeSessionIds: SESSIONS,
                    nextHopsBySessionId: toChain(SESSIONS),
                    degreeLimit: 3
                },
                leaderSessionId: 'session-a',
                meshParamK: 2
            })
        ).toEqual({ acceptedLongestPathHops: 7, freshLongestPathHops: 4, hopDifference: 3 });
    });

    it('measures a negative difference for an accepted tree shorter than the fresh no-RTT tree', () => {
        // Two hubs a and b, each with three more members: three hops across at degree limit 4. The planner's no-RTT
        // tree from leader session-a over the same eight sessions is four hops across, so it is the reference layout,
        // not the shortest one.
        const twoHubs = {
            'session-a': ['session-b', 'session-c', 'session-d', 'session-e'],
            'session-b': ['session-a', 'session-f', 'session-g', 'session-h'],
            'session-c': ['session-a'],
            'session-d': ['session-a'],
            'session-e': ['session-a'],
            'session-f': ['session-b'],
            'session-g': ['session-b'],
            'session-h': ['session-b']
        };

        expect(
            computeTopologyChurnDrift({
                layout: { topology: 'tree', activeSessionIds: SESSIONS, nextHopsBySessionId: twoHubs, degreeLimit: 4 },
                leaderSessionId: 'session-a',
                meshParamK: 2
            })
        ).toEqual({ acceptedLongestPathHops: 3, freshLongestPathHops: 4, hopDifference: -1 });
    });

    it('measures no difference for a tree that is the fresh plan', () => {
        const fresh = computeNoRttTopologyNextHops({
            topology: 'tree',
            activeSessionIds: SESSIONS,
            preferredSourceSessionId: 'session-c',
            degreeLimit: 2,
            meshParamK: 0
        });

        expect(
            computeTopologyChurnDrift({
                layout: { topology: 'tree', activeSessionIds: SESSIONS, nextHopsBySessionId: fresh, degreeLimit: 2 },
                leaderSessionId: 'session-c',
                meshParamK: 2
            })
        ).toMatchObject({ hopDifference: 0 });
    });

    it('measures no difference for a star, whose fresh plan connects every pair', () => {
        const star = {
            'session-a': ['session-b', 'session-c'],
            'session-b': ['session-a', 'session-c'],
            'session-c': ['session-a', 'session-b']
        };

        expect(
            computeTopologyChurnDrift({
                layout: {
                    topology: 'star',
                    activeSessionIds: ['session-a', 'session-b', 'session-c'],
                    nextHopsBySessionId: star,
                    degreeLimit: 4
                },
                leaderSessionId: undefined,
                meshParamK: 2
            })
        ).toEqual({ acceptedLongestPathHops: 1, freshLongestPathHops: 1, hopDifference: 0 });
    });

    it('measures an accepted mesh against a fresh no-RTT mesh with the room\'s mesh parameter', () => {
        // Over these nine sessions at degree limit 5 the planner's no-RTT mesh is 7 hops across with k = 1, 4 with
        // k = 2, 2 with k = 3 and 3 with k = 4: only the room's k = 2 gives 4.
        const nineSessions = [...SESSIONS, 'session-i'];

        expect(
            computeTopologyChurnDrift({
                layout: {
                    topology: 'mesh',
                    activeSessionIds: nineSessions,
                    nextHopsBySessionId: toChain(nineSessions),
                    degreeLimit: 5
                },
                leaderSessionId: 'session-a',
                meshParamK: 2
            })
        ).toEqual({ acceptedLongestPathHops: 8, freshLongestPathHops: 4, hopDifference: 4 });
    });
});
