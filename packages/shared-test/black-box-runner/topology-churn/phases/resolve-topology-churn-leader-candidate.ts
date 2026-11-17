import { compareRtcTopologyIdentifiers } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import { computeTopologyHopLevels } from '@shared-server/rallar-system/topology/planning/compute-topology-hop-levels.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

interface ResolveTopologyChurnLeaderCandidateInput {
    readonly layout: Pick<RallarOverlayTopologySnapshot, 'activeSessionIds' | 'nextHopsBySessionId'>;
    /** Only a present session can appoint itself; the layout can still hold a session that has left. */
    readonly presentSessionIds: readonly string[];
    readonly leaderSessionId: string | null;
}

interface EccentricSession {
    readonly sessionId: string;
    readonly eccentricity: number;
}

/**
 * The present session other than the leader with the largest hop eccentricity over the whole layout, a departed
 * session's hops included, the first in identifier order on a tie: the kept tree is deepest from it. Appointed, it
 * makes the planner's leader rule rebuild the tree rooted at it whenever the planner's no-RTT tree rooted at it is
 * shallower.
 */
export function resolveTopologyChurnLeaderCandidate(input: ResolveTopologyChurnLeaderCandidateInput): string | null {
    const { nextHopsBySessionId } = input.layout;
    const neighboursOf = (sessionId: string): readonly string[] => nextHopsBySessionId[sessionId] ?? [];
    const deepest = input.layout.activeSessionIds
        .filter((sessionId) => sessionId !== input.leaderSessionId && input.presentSessionIds.includes(sessionId))
        .sort(compareRtcTopologyIdentifiers)
        .map((sessionId): EccentricSession => ({
            sessionId,
            eccentricity: computeTopologyHopLevels(neighboursOf, sessionId).length - 1
        }))
        .reduce<EccentricSession | null>(
            (kept, session) => kept === null || session.eccentricity > kept.eccentricity ? session : kept,
            null
        );
    return deepest?.sessionId ?? null;
}
