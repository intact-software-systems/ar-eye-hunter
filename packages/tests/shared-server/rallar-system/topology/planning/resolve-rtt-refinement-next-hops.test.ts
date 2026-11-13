import { describe, expect, it } from 'vitest';

import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { createRtcRoomGraph } from '@shared-server/rallar-system/topology/planning/create-rtc-room-graph.ts';
import {
    resolveRttRefinementNextHops,
    type ResolveRttRefinementNextHopsInput
} from '@shared-server/rallar-system/topology/planning/resolve-rtt-refinement-next-hops.ts';
import { computeRtcTopologyPlan, type ComputedRtcTopologyPlan } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import type { RtcTopologyPlanningIntent } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
    computeRtcTopologyHopEccentricity,
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement,
    toRtcTopologyGroupWithDirector
} from '../rtc-topology-test-fixtures.ts';

const MEMBER_COUNT = 50;
const DIRECTOR_SESSION_ID = 'peer-25';

describe('RTT refinement of a director-rooted tree', () => {
    it('keeps the formed tree when the measured RTTs promise no worthwhile gain on the director paths', () => {
        const formed = formDirectorFirstTree();
        const group = createDirectedGroup(MEMBER_COUNT);
        const toLoopbackRttMs = (index: number) => 0.3 + ((index * 37) % 28) / 10;

        const refined = planTree({
            group,
            previous: formed.snapshot,
            rttMeasurements: [
                ...createTreeEdgeRttMeasurements(formed.snapshot.nextHopsBySessionId, toLoopbackRttMs),
                ...createFormerPeerRttMeasurements(toLoopbackRttMs)
            ],
            planningIntent: 'full-rebuild'
        });

        const formedEdges = toEdgeSet(formed.snapshot.nextHopsBySessionId);
        const keptEdges = [...toEdgeSet(refined.snapshot.nextHopsBySessionId)].filter((edge) => formedEdges.has(edge));
        expect(keptEdges.length).toBeGreaterThanOrEqual(Math.ceil(formedEdges.size * 0.75));
        expect(computeRtcTopologyHopEccentricity(refined.snapshot.nextHopsBySessionId, DIRECTOR_SESSION_ID)).toBeLessThanOrEqual(
            computeRtcTopologyHopEccentricity(planTree({ group, previous: undefined }).snapshot.nextHopsBySessionId, DIRECTOR_SESSION_ID)
        );
        expectValidPlan(refined);
    });

    it('rebuilds the formed tree when cheaper measured links shorten the director paths by far more than the threshold', () => {
        const formed = formDirectorFirstTree();
        const group = createDirectedGroup(MEMBER_COUNT);
        const formedEdges = toEdgeSet(formed.snapshot.nextHopsBySessionId);
        const memberSessionIds = createRtcTopologyMemberIds(MEMBER_COUNT);
        const rttMeasurements = memberSessionIds.flatMap((from, fromIndex) =>
            memberSessionIds.slice(fromIndex + 1).map((to, toIndex) =>
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: from,
                    sessionIdTo: to,
                    rttMs: formedEdges.has(toEdge(from, to)) ? 200 : 10,
                    version: fromIndex * MEMBER_COUNT + toIndex + 1
                })
            )
        );

        const refined = planTree({ group, previous: formed.snapshot, rttMeasurements, planningIntent: 'full-rebuild' });
        const rebuilt = planTree({ group, previous: undefined, rttMeasurements, planningIntent: 'full-rebuild' });

        expect(refined.snapshot.nextHopsBySessionId).toEqual(rebuilt.snapshot.nextHopsBySessionId);
        expect(refined.snapshot.nextHopsBySessionId).not.toEqual(formed.snapshot.nextHopsBySessionId);
        expectValidPlan(refined);
    });
});

describe('RTT refinement of a leaderless tree', () => {
    const LEADERLESS_SESSION_IDS = createRtcTopologyMemberIds(6);
    const PATH_NEXT_HOPS = toPathNextHops(LEADERLESS_SESSION_IDS);
    const STAR_NEXT_HOPS = toStarNextHops(LEADERLESS_SESSION_IDS);

    it.each([
        {
            gate: 'a 20 % shorter slowest path, short of the quarter',
            uniformRttMs: 20,
            rebuiltNextHopsBySessionId: toForkNextHops(LEADERLESS_SESSION_IDS)
        },
        {
            gate: 'a 60 % shorter slowest path that saves only 6 ms',
            uniformRttMs: 2,
            rebuiltNextHopsBySessionId: STAR_NEXT_HOPS
        }
    ])('keeps the accepted tree at unchanged membership for $gate', ({ uniformRttMs, rebuiltNextHopsBySessionId }) => {
        const refined = resolveRttRefinementNextHops({
            evolve: createLeaderlessEvolveInput(LEADERLESS_SESSION_IDS, PATH_NEXT_HOPS),
            rttMeasurements: createUniformRttMeasurements(LEADERLESS_SESSION_IDS, uniformRttMs),
            rebuiltNextHopsBySessionId
        });

        expect(refined).toEqual(PATH_NEXT_HOPS);
    });

    it('rebuilds when the rebuild shortens the slowest path between any two members by a quarter and 10 ms', () => {
        const refined = resolveRttRefinementNextHops({
            evolve: createLeaderlessEvolveInput(LEADERLESS_SESSION_IDS, PATH_NEXT_HOPS),
            rttMeasurements: createUniformRttMeasurements(LEADERLESS_SESSION_IDS, 20),
            rebuiltNextHopsBySessionId: STAR_NEXT_HOPS
        });

        expect(refined).toEqual(STAR_NEXT_HOPS);
    });

    it('weighs an unmeasured rebuilt link at the slowest measured RTT, so a rebuild over unmeasured links is kept out', () => {
        const [first, second, third, , fifth] = LEADERLESS_SESSION_IDS as [string, string, string, string, string];
        const rttMeasurements = [
            ...[...toEdgeSet(PATH_NEXT_HOPS)].map((edge, index) => {
                const [sessionIdFrom, sessionIdTo] = edge.split('|') as [string, string];
                return createRtcTopologyRttMeasurement({ sessionIdFrom, sessionIdTo, rttMs: 10, version: index + 1 });
            }),
            createRtcTopologyRttMeasurement({ sessionIdFrom: first, sessionIdTo: third, rttMs: 1, version: 100 }),
            createRtcTopologyRttMeasurement({ sessionIdFrom: second, sessionIdTo: fifth, rttMs: 60, version: 101 })
        ];

        // The accepted path is 50 ms end to end; the star's three unmeasured spokes weigh 60 ms each, so its
        // slowest path is 120 ms, where weighing them at nothing would have made it 11 ms and won the rebuild.
        const refined = resolveRttRefinementNextHops({
            evolve: createLeaderlessEvolveInput(LEADERLESS_SESSION_IDS, PATH_NEXT_HOPS),
            rttMeasurements,
            rebuiltNextHopsBySessionId: STAR_NEXT_HOPS
        });

        expect(refined).toEqual(PATH_NEXT_HOPS);
    });

    it('returns the rebuild when the membership change is too large to evolve the accepted tree', () => {
        const remainingSessionIds = LEADERLESS_SESSION_IDS.slice(0, 3);
        const rebuiltNextHopsBySessionId = toPathNextHops([...remainingSessionIds].reverse());

        const refined = resolveRttRefinementNextHops({
            evolve: {
                ...createLeaderlessEvolveInput(LEADERLESS_SESSION_IDS, PATH_NEXT_HOPS),
                group: createRtcTopologyGroupSnapshot('leaderless-refinement-group', remainingSessionIds),
                activeSessionIds: remainingSessionIds
            },
            rttMeasurements: createUniformRttMeasurements(LEADERLESS_SESSION_IDS, 20),
            rebuiltNextHopsBySessionId
        });

        expect(refined).toEqual(rebuiltNextHopsBySessionId);
    });
});

function createLeaderlessEvolveInput(
    sessionIds: readonly string[],
    acceptedNextHopsBySessionId: Readonly<Record<string, readonly string[]>>
): ResolveRttRefinementNextHopsInput['evolve'] {
    const group = createRtcTopologyGroupSnapshot('leaderless-refinement-group', sessionIds);
    const accepted = planTree({ group, previous: undefined }).snapshot;
    const roomGraph = createRtcRoomGraph({
        group,
        activeSessionIds: sessionIds,
        preferredSourceSessionId: undefined,
        rttMeasurements: [],
        degreeLimit: 5,
        rttReportingDegreeLimit: 5,
        seedTopology: 'tree',
        meshParamK: 2
    });
    if (roomGraph.outcome !== 'ready') {
        throw new Error('The complete fallback room graph must be ready');
    }
    return {
        previous: { ...accepted, nextHopsBySessionId: acceptedNextHopsBySessionId },
        group,
        leaderSessionId: undefined,
        activeSessionIds: sessionIds,
        globalGraph: roomGraph.graph,
        kind: 'tree',
        degreeLimit: 5,
        meshParamK: 2
    };
}

function createUniformRttMeasurements(sessionIds: readonly string[], rttMs: number): readonly RttMeasurementInfo[] {
    return sessionIds.flatMap((sessionIdFrom, fromIndex) =>
        sessionIds.slice(fromIndex + 1).map((sessionIdTo, toIndex) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom,
                sessionIdTo,
                rttMs,
                version: fromIndex * sessionIds.length + toIndex + 1
            })
        )
    );
}

function toPathNextHops(sessionIds: readonly string[]): Record<string, readonly string[]> {
    return Object.fromEntries(sessionIds.map((sessionId, index) => [
        sessionId,
        [sessionIds[index - 1], sessionIds[index + 1]].filter((peer) => peer !== undefined).sort()
    ]));
}

/** The path over all but the last member, with the last forked off the spine's second-to-last: four links end to end. */
function toForkNextHops(sessionIds: readonly string[]): Record<string, readonly string[]> {
    const spine = sessionIds.slice(0, -1);
    const forked = sessionIds.at(-1)!;
    const forkParent = spine.at(-2)!;
    const spineNextHops = toPathNextHops(spine);
    return {
        ...spineNextHops,
        [forkParent]: [...(spineNextHops[forkParent] ?? []), forked].sort(),
        [forked]: [forkParent]
    };
}

function toStarNextHops(sessionIds: readonly string[]): Record<string, readonly string[]> {
    const [hub, ...spokes] = sessionIds as [string, ...string[]];
    return { [hub]: [...spokes].sort(), ...Object.fromEntries(spokes.map((spoke) => [spoke, [hub]])) };
}

interface PlanTreeInput {
    readonly group: GroupSnapshot;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly rttMeasurements?: readonly RttMeasurementInfo[];
    readonly planningIntent?: RtcTopologyPlanningIntent;
}

function planTree(input: PlanTreeInput): ComputedRtcTopologyPlan {
    return computeRtcTopologyPlan(
        { topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 5 },
        {
            group: input.group,
            rttMeasurements: input.rttMeasurements ?? [],
            previous: input.previous,
            updateOptions: { planningIntent: input.planningIntent ?? 'membership-delta' },
            nowEpochMs: 100
        }
    );
}

/** The scale cohorts appoint the director alone, then the players join it in one burst. */
function formDirectorFirstTree(): ComputedRtcTopologyPlan {
    const alone = planTree({ group: createDirectedGroup(1), previous: undefined });
    return planTree({ group: createDirectedGroup(MEMBER_COUNT), previous: alone.snapshot });
}

function createDirectedGroup(memberCount: number): GroupSnapshot {
    const joinOrder = [
        DIRECTOR_SESSION_ID,
        ...createRtcTopologyMemberIds(MEMBER_COUNT).filter((sessionId) => sessionId !== DIRECTOR_SESSION_ID)
    ];
    return toRtcTopologyGroupWithDirector(
        createRtcTopologyGroupSnapshot('refinement-group', joinOrder.slice(0, memberCount)),
        DIRECTOR_SESSION_ID
    );
}

function createTreeEdgeRttMeasurements(
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
    toRttMs: (index: number) => number
): readonly RttMeasurementInfo[] {
    return [...toEdgeSet(nextHopsBySessionId)].map((edge, index) => {
        const [sessionIdFrom, sessionIdTo] = edge.split('|') as [string, string];
        return createRtcTopologyRttMeasurement({ sessionIdFrom, sessionIdTo, rttMs: toRttMs(index), version: index + 1 });
    });
}

/** Peers dialed under an earlier formation layout keep reporting RTT beside the accepted tree edges. */
function createFormerPeerRttMeasurements(toRttMs: (index: number) => number): readonly RttMeasurementInfo[] {
    const memberSessionIds = createRtcTopologyMemberIds(MEMBER_COUNT);
    return memberSessionIds.flatMap((sessionIdFrom, index) =>
        [7, 13].map((offset) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom,
                sessionIdTo: memberSessionIds[(index + offset) % MEMBER_COUNT]!,
                rttMs: toRttMs(index + offset),
                version: 10_000 + index * 2 + offset
            })
        )
    );
}

function toEdgeSet(nextHopsBySessionId: Readonly<Record<string, readonly string[]>>): Set<string> {
    const edges = new Set<string>();
    for (const [from, nextHops] of Object.entries(nextHopsBySessionId)) {
        for (const to of nextHops) {
            edges.add(toEdge(from, to));
        }
    }
    return edges;
}

function toEdge(left: string, right: string): string {
    return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function expectValidPlan(result: ComputedRtcTopologyPlan): void {
    const validation = validateGroupTopologyNextHops({
        activeSessionIds: new Set(result.snapshot.activeSessionIds),
        nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
        maxDegree: result.snapshot.degreeLimit
    });
    expect(validation.issues).toEqual([]);
}
