import { computeNoRttTopologyNextHops } from '@shared-server/rallar-system/topology/planning/compute-no-rtt-topology-next-hops.ts';
import { computeTopologyChurnDrift } from '@shared-test/black-box-runner/topology-churn/compute-topology-churn-drift.ts';
import { describe, expect, it } from 'vitest';

const SESSIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter) => `session-${letter}`);

// session-a – session-b – … – session-h: seven hops end to end.
const CHAIN: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
    SESSIONS.map((sessionId, index) => [sessionId, [SESSIONS[index - 1], SESSIONS[index + 1]].filter(isSessionId)])
);

function isSessionId(sessionId: string | undefined): sessionId is string {
    return sessionId !== undefined;
}

describe('computeTopologyChurnDrift', () => {
    it('measures the extra hops of a chain over a fresh no-RTT tree for the same members', () => {
        // With degree limit 3 and leader session-a the planner's no-RTT tree over these eight sessions is four hops deep.
        expect(
            computeTopologyChurnDrift({
                layout: { topology: 'tree', activeSessionIds: SESSIONS, nextHopsBySessionId: CHAIN, degreeLimit: 3 },
                leaderSessionId: 'session-a'
            })
        ).toEqual({ status: 'measured', acceptedLongestPathHops: 7, freshLongestPathHops: 4, extraHops: 3 });
    });

    it('measures no extra hops for a tree that is the fresh plan', () => {
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
                leaderSessionId: 'session-c'
            })
        ).toMatchObject({ status: 'measured', extraHops: 0 });
    });

    it('measures no extra hops for a star, whose fresh plan connects every pair', () => {
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
                leaderSessionId: undefined
            })
        ).toEqual({ status: 'measured', acceptedLongestPathHops: 1, freshLongestPathHops: 1, extraHops: 0 });
    });

    it('answers undetermined with its reason for a mesh, whose fresh plan needs the unserved mesh parameter', () => {
        const drift = computeTopologyChurnDrift({
            layout: { topology: 'mesh', activeSessionIds: SESSIONS, nextHopsBySessionId: CHAIN, degreeLimit: 4 },
            leaderSessionId: undefined
        });

        expect(drift.status).toBe('undetermined');
        expect(drift.status === 'undetermined' && drift.reason).toContain('mesh parameter');
    });
});
