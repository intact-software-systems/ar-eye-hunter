import { describe, expect, it } from 'vitest';

import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
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
