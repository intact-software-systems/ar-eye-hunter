import type { TopologyLayoutDelta } from '@shared/api/topology-plan/rtc-topology-plan-record.ts';

export interface TopologyLayoutEdges {
    readonly activeSessionIds: readonly string[];
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

interface TopologyLayoutComparison {
    readonly before: ReadonlyMap<string, ReadonlySet<string>>;
    readonly after: ReadonlyMap<string, ReadonlySet<string>>;
    readonly dependantSessionIds: ReadonlySet<string>;
}

const EMPTY_LAYOUT: TopologyLayoutEdges = { activeSessionIds: [], nextHopsBySessionId: {} };
const NO_NEIGHBOURS: ReadonlySet<string> = new Set();

export function computeTopologyLayoutDelta(
    previous: TopologyLayoutEdges | null,
    next: TopologyLayoutEdges
): TopologyLayoutDelta {
    const before = toUndirectedNeighbours(previous ?? EMPTY_LAYOUT);
    const after = toUndirectedNeighbours(next);
    const joinerSessionIds = new Set([...after.keys()].filter((sessionId) => !before.has(sessionId)));
    const leaverSessionIds = [...before.keys()].filter((sessionId) => !after.has(sessionId));
    const stayerSessionIds = [...after.keys()].filter((sessionId) => before.has(sessionId));
    const dependantSessionIds = new Set(
        leaverSessionIds.flatMap((sessionId) => [...readNeighbours(before, sessionId)])
            .filter((sessionId) => after.has(sessionId))
    );
    const comparison: TopologyLayoutComparison = { before, after, dependantSessionIds };
    const joinerEdgeCounts = stayerSessionIds.map((sessionId) =>
        [...readNeighbours(after, sessionId)].filter((neighbour) => joinerSessionIds.has(neighbour)).length
    );
    return {
        joinedSessionCount: joinerSessionIds.size,
        leftSessionCount: leaverSessionIds.length,
        changedSessionCount:
            stayerSessionIds.filter((sessionId) =>
                !hasSameMembers(readNeighbours(before, sessionId), readNeighbours(after, sessionId))
            ).length,
        reroutedSessionCount: stayerSessionIds.filter((sessionId) => isRerouted(comparison, sessionId)).length,
        acceptingSessionCount: joinerEdgeCounts.filter((count) => count > 0).length,
        maxJoinerEdgesPerSession: Math.max(0, ...joinerEdgeCounts)
    };
}

/** An edge exists when either end lists the other; a hop to a non-member or to itself is no edge. */
function toUndirectedNeighbours(layout: TopologyLayoutEdges): ReadonlyMap<string, ReadonlySet<string>> {
    const neighbours = new Map(layout.activeSessionIds.map((sessionId) => [sessionId, new Set<string>()]));
    for (const [sessionId, sessionNeighbours] of neighbours) {
        for (const hop of layout.nextHopsBySessionId[sessionId] ?? []) {
            const hopNeighbours = neighbours.get(hop);
            if (hop !== sessionId && hopNeighbours !== undefined) {
                sessionNeighbours.add(hop);
                hopNeighbours.add(sessionId);
            }
        }
    }
    return neighbours;
}

function readNeighbours(layout: ReadonlyMap<string, ReadonlySet<string>>, sessionId: string): ReadonlySet<string> {
    return layout.get(sessionId) ?? NO_NEIGHBOURS;
}

function hasSameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    return left.size === right.size && [...left].every((sessionId) => right.has(sessionId));
}

/** A removed edge between stayers always reroutes; an added one reroutes only when neither end is a dependant. */
function isRerouted(comparison: TopologyLayoutComparison, sessionId: string): boolean {
    const { before, after, dependantSessionIds } = comparison;
    const neighboursBefore = readNeighbours(before, sessionId);
    const neighboursAfter = readNeighbours(after, sessionId);
    const lostStayerEdge = [...neighboursBefore].some((neighbour) =>
        after.has(neighbour) && !neighboursAfter.has(neighbour)
    );
    const gainedFreeStayerEdge = !dependantSessionIds.has(sessionId) &&
        [...neighboursAfter].some((neighbour) =>
            before.has(neighbour) && !neighboursBefore.has(neighbour) && !dependantSessionIds.has(neighbour)
        );
    return lostStayerEdge || gainedFreeStayerEdge;
}
