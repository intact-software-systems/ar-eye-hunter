import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { selectRttReportingPeers } from '@shared/rtc/rtt-reporting-policy.ts';

export interface TopologyChurnRttPair {
    readonly sessionIdFrom: string;
    readonly sessionIdTo: string;
}

export interface TopologyChurnRttReport extends TopologyChurnRttPair {
    readonly rttMs: number;
}

export type TopologyChurnRttMatrixShape = 'uniform' | 'skewed';

/** Skewed: every layout link is slow and every other measured pair fast, so a weighted rebuild shortens the tree. */
export const TOPOLOGY_CHURN_RTT_MS = { uniform: 50, layoutLink: 120, otherPair: 10 } as const;

interface ComputeTopologyChurnRttPairsInput {
    readonly layout: Pick<RallarOverlayTopologySnapshot, 'activeSessionIds' | 'nextHopsBySessionId'>;
    readonly roomRef: GroupRef;
    readonly reportingDegreeLimit: number;
    /** The sessions that can send a report; a pair is reported by its canonical (lesser) session. */
    readonly reporterSessionIds: readonly string[];
}

interface ComputeTopologyChurnRttMatrixInput {
    readonly pairs: readonly TopologyChurnRttPair[];
    readonly layout: Pick<RallarOverlayTopologySnapshot, 'nextHopsBySessionId'>;
    readonly shape: TopologyChurnRttMatrixShape;
}

/** The layout's links first, then each session's reporting selection, each endpoint in at most the limit's pairs. */
export function computeTopologyChurnRttPairs(
    input: ComputeTopologyChurnRttPairsInput
): readonly TopologyChurnRttPair[] {
    const sessionIds = [...input.layout.activeSessionIds].sort();
    const toNextHops = (sessionId: string): readonly string[] =>
        [...(input.layout.nextHopsBySessionId[sessionId] ?? [])].sort();
    const layoutLinks = sessionIds.flatMap((sessionId) =>
        toNextHops(sessionId).map((peerId) => toCanonicalPair(sessionId, peerId))
    );
    const selectedPairs = sessionIds.flatMap((sessionId) =>
        selectRttReportingPeers({
            localSessionId: sessionId,
            degreeLimit: input.reportingDegreeLimit,
            overlayNextHopSessionIds: toNextHops(sessionId),
            activePeerSessionIds: input.layout.activeSessionIds,
            groupKey: toWebRtcGroupKey(input.roomRef)
        }).selectedPeerIds.map((peerId) => toCanonicalPair(sessionId, peerId))
    );
    const pairCountBySessionId = new Map<string, number>();
    const countPairs = (sessionId: string): number => pairCountBySessionId.get(sessionId) ?? 0;
    const kept: TopologyChurnRttPair[] = [];
    for (const pair of [...layoutLinks, ...selectedPairs]) {
        if (
            input.reporterSessionIds.includes(pair.sessionIdFrom) &&
            !kept.some((keptPair) => isSamePair(keptPair, pair)) &&
            countPairs(pair.sessionIdFrom) < input.reportingDegreeLimit &&
            countPairs(pair.sessionIdTo) < input.reportingDegreeLimit
        ) {
            kept.push(pair);
            pairCountBySessionId.set(pair.sessionIdFrom, countPairs(pair.sessionIdFrom) + 1);
            pairCountBySessionId.set(pair.sessionIdTo, countPairs(pair.sessionIdTo) + 1);
        }
    }
    return kept;
}

export function computeTopologyChurnRttMatrix(
    input: ComputeTopologyChurnRttMatrixInput
): readonly TopologyChurnRttReport[] {
    return input.pairs.map((pair) => ({ ...pair, rttMs: resolveRttMs(input, pair) }));
}

function resolveRttMs(input: ComputeTopologyChurnRttMatrixInput, pair: TopologyChurnRttPair): number {
    if (input.shape === 'uniform') {
        return TOPOLOGY_CHURN_RTT_MS.uniform;
    }
    const isLayoutLink = (input.layout.nextHopsBySessionId[pair.sessionIdFrom] ?? []).includes(pair.sessionIdTo);
    return isLayoutLink ? TOPOLOGY_CHURN_RTT_MS.layoutLink : TOPOLOGY_CHURN_RTT_MS.otherPair;
}

function toCanonicalPair(sessionId: string, peerId: string): TopologyChurnRttPair {
    return sessionId < peerId
        ? { sessionIdFrom: sessionId, sessionIdTo: peerId }
        : { sessionIdFrom: peerId, sessionIdTo: sessionId };
}

function isSamePair(left: TopologyChurnRttPair, right: TopologyChurnRttPair): boolean {
    return left.sessionIdFrom === right.sessionIdFrom && left.sessionIdTo === right.sessionIdTo;
}
