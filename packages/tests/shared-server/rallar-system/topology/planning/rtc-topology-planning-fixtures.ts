import { computeCanonicalTopologyPairWeight } from '@shared-server/rallar-system/topology/planning/canonical-topology-planning-input.ts';
import { computeRtcTopologyPlan, type ComputedRtcTopologyPlan } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import type {
    RallarRtcTopologyServiceOptions,
    RtcTopologyPlanningIntent
} from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { TopologyReshapeReason } from '@shared/api/topology-plan/topology-plan-change.ts';
import { selectRttReportingPeers } from '@shared/rtc/rtt-reporting-policy.ts';

import {
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement,
    toRtcTopologyGroupWithDirector
} from '../rtc-topology-test-fixtures.ts';

export const RTC_TOPOLOGY_TREE_OPTIONS: RallarRtcTopologyServiceOptions = {
    topologyKind: 'tree',
    degreeLimit: 5,
    rttReportingDegreeLimit: 5
};
export const RTC_TOPOLOGY_MESH_OPTIONS: RallarRtcTopologyServiceOptions = {
    topologyKind: 'mesh',
    degreeLimit: 5,
    rttReportingDegreeLimit: 5
};
export const RTC_TOPOLOGY_STAR_OPTIONS: RallarRtcTopologyServiceOptions = {
    topologyKind: 'star',
    degreeLimit: 5,
    rttReportingDegreeLimit: 5
};
/** No fixed kind: the planner selects star, tree or mesh by the room's size, a mesh from 16 members. */
export const RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS: RallarRtcTopologyServiceOptions = { degreeLimit: 5, rttReportingDegreeLimit: 5 };

interface RtcTopologyFixturePlanInput {
    readonly options: RallarRtcTopologyServiceOptions;
    readonly group: GroupSnapshot;
    readonly previous: RallarOverlayTopologySnapshot | undefined;
    readonly planningIntent?: RtcTopologyPlanningIntent;
    readonly rttMeasurements?: readonly RttMeasurementInfo[];
}

/** A previously accepted layout and the plan the real planner derives from it. */
export interface RtcTopologyFixtureReplan {
    readonly previous: RallarOverlayTopologySnapshot;
    readonly planned: ComputedRtcTopologyPlan;
}

/** A replan with the planning input it was derived from: the room, options, intent and measurements. */
export interface RtcTopologyFixtureReplanned extends RtcTopologyFixtureReplan {
    readonly replanInput: RtcTopologyFixturePlanInput;
}

interface RtcTopologyFixtureLeave extends RtcTopologyFixtureReplanned {
    readonly leaverSessionId: string;
}

export function computeRtcTopologyFixturePlan(input: RtcTopologyFixturePlanInput): ComputedRtcTopologyPlan {
    return computeRtcTopologyPlan(input.options, {
        group: input.group,
        rttMeasurements: input.rttMeasurements ?? [],
        previous: input.previous,
        updateOptions: { planningIntent: input.planningIntent ?? 'membership-delta' },
        nowEpochMs: 100
    });
}

export function createRtcTopologyFixtureGroup(memberCount: number): GroupSnapshot {
    return createRtcTopologyFixtureGroupOf(createRtcTopologyMemberIds(memberCount));
}

function createRtcTopologyFixtureGroupOf(memberSessionIds: readonly string[]): GroupSnapshot {
    return createRtcTopologyGroupSnapshot('derivation-group', memberSessionIds);
}

function createRtcTopologyLedFixtureGroup(memberCount: number): GroupSnapshot {
    return toRtcTopologyGroupWithDirector(createRtcTopologyFixtureGroup(memberCount), 'peer-1');
}

/** A leaver named by its session id, or the first session of the formed layout whose next-hop count matches. */
type RtcTopologyFixtureLeaver = string | ((nextHopCount: number) => boolean);

export interface RtcTopologyFixtureLeaveInput {
    readonly options: RallarRtcTopologyServiceOptions;
    readonly memberCount: number;
    readonly leaver: RtcTopologyFixtureLeaver;
    /** Members that join in the same plan as the leave, after the formed members. */
    readonly joinerCount: number;
}

/** Plans a first layout of the members, then plans the room again without the leaver and with the joiners. */
export function computeRtcTopologyFixtureLeave(input: RtcTopologyFixtureLeaveInput): RtcTopologyFixtureLeave {
    const sessionIds = createRtcTopologyMemberIds(input.memberCount + input.joinerCount);
    const previous = computeRtcTopologyFixturePlan({
        options: input.options,
        group: createRtcTopologyFixtureGroup(input.memberCount),
        previous: undefined
    }).snapshot;
    const leaverSessionId = typeof input.leaver === 'string'
        ? input.leaver
        : resolveRtcTopologyFixtureSessionId(previous, input.leaver);
    const replanInput: RtcTopologyFixturePlanInput = {
        options: input.options,
        group: createRtcTopologyFixtureGroupOf(sessionIds.filter((sessionId) => sessionId !== leaverSessionId)),
        previous
    };
    return { previous, planned: computeRtcTopologyFixturePlan(replanInput), replanInput, leaverSessionId };
}

function resolveRtcTopologyFixtureSessionId(
    snapshot: RallarOverlayTopologySnapshot,
    matches: (nextHopCount: number) => boolean
): string {
    const sessionId = snapshot.activeSessionIds.find((candidate) => matches(snapshot.nextHopsBySessionId[candidate]?.length ?? 0));
    if (sessionId === undefined) {
        throw new Error('The formed layout has no session of the wanted shape');
    }
    return sessionId;
}

export function createRtcTopologyFixtureRttMeasurements(
    sessionIds: readonly string[],
    toRttMs: (from: string, to: string) => number
): readonly RttMeasurementInfo[] {
    return sessionIds.flatMap((sessionIdFrom, fromIndex) =>
        sessionIds.slice(fromIndex + 1).map((sessionIdTo, toIndex) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom,
                sessionIdTo,
                rttMs: toRttMs(sessionIdFrom, sessionIdTo),
                version: fromIndex * sessionIds.length + toIndex + 1
            })
        )
    );
}

interface RtcTopologyFixtureReportedRttInput {
    readonly group: GroupSnapshot;
    /** The accepted layout whose links each browser measures first; links to members no longer in the room are skipped. */
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
    readonly rttReportingDegreeLimit: number;
}

/**
 * The RTT the members' browsers report: each member measures the peers the production reporting policy selects
 * (its overlay next hops first, then rendezvous-ordered peers, up to the reporting limit), and a pair measures ten
 * times its canonical pair weight, so the measurements are deterministic and spread like real ones.
 */
export function createRtcTopologyFixtureReportedRttMeasurements(input: RtcTopologyFixtureReportedRttInput): readonly RttMeasurementInfo[] {
    const sessionIds = input.group.activeSessions.map((session) => session.sessionId);
    const groupKey = toWebRtcGroupKey(input.group.group);
    const reportedPairs = new Map<string, readonly [string, string]>();
    for (const localSessionId of sessionIds) {
        const { selectedPeerIds } = selectRttReportingPeers({
            localSessionId,
            degreeLimit: input.rttReportingDegreeLimit,
            overlayNextHopSessionIds: (input.nextHopsBySessionId[localSessionId] ?? []).filter((peer) => sessionIds.includes(peer)),
            activePeerSessionIds: sessionIds,
            groupKey
        });
        for (const peerSessionId of selectedPeerIds) {
            reportedPairs.set(
                toRtcTopologyFixtureEdge(localSessionId, peerSessionId),
                localSessionId < peerSessionId ? [localSessionId, peerSessionId] : [peerSessionId, localSessionId]
            );
        }
    }
    return [...reportedPairs.values()].map(([sessionIdFrom, sessionIdTo], index) =>
        createRtcTopologyRttMeasurement({
            sessionIdFrom,
            sessionIdTo,
            rttMs: 10 * computeCanonicalTopologyPairWeight(sessionIdFrom, sessionIdTo),
            version: index + 1
        })
    );
}

export interface RtcTopologyFixtureMeasuredLeaveInput {
    readonly options: RallarRtcTopologyServiceOptions;
    readonly formed: RallarOverlayTopologySnapshot;
    readonly leaverSessionId: string;
    readonly rttReportingDegreeLimit: number;
}

/** Plans the formed room again without the leaver, with the RTT its remaining members' browsers report. */
export function computeRtcTopologyFixtureMeasuredLeave(input: RtcTopologyFixtureMeasuredLeaveInput): ComputedRtcTopologyPlan {
    const group = createRtcTopologyFixtureGroupOf(
        input.formed.activeSessionIds.filter((sessionId) => sessionId !== input.leaverSessionId)
    );
    return computeRtcTopologyFixturePlan({
        options: input.options,
        group,
        previous: input.formed,
        rttMeasurements: createRtcTopologyFixtureReportedRttMeasurements({
            group,
            nextHopsBySessionId: input.formed.nextHopsBySessionId,
            rttReportingDegreeLimit: input.rttReportingDegreeLimit
        })
    });
}

/** The part of a planned layout the connectivity check reads. */
export type RtcTopologyFixtureLayout = Pick<RallarOverlayTopologySnapshot, 'activeSessionIds' | 'nextHopsBySessionId' | 'degreeLimit'>;

/**
 * Every link is two-way and inside the degree limit, and a walk over next hops from the first member reaches every
 * member, so in a room of two or more every member holds at least one link.
 */
export function isConnectedRtcTopologyFixtureLayout(planned: RtcTopologyFixtureLayout): boolean {
    const readNextHops = (sessionId: string) => planned.nextHopsBySessionId[sessionId] ?? [];
    const reachedSessionIds = computeRtcTopologyFixtureReachedSessionIds(planned);
    return planned.activeSessionIds.every((sessionId) =>
        readNextHops(sessionId).length <= planned.degreeLimit &&
        readNextHops(sessionId).every((nextHop) => readNextHops(nextHop).includes(sessionId)) &&
        reachedSessionIds.has(sessionId)
    );
}

/** The members a walk over next hops reaches from the first member. */
function computeRtcTopologyFixtureReachedSessionIds(planned: RtcTopologyFixtureLayout): ReadonlySet<string> {
    const reachedSessionIds = new Set(planned.activeSessionIds.slice(0, 1));
    for (const sessionId of reachedSessionIds) {
        for (const nextHop of planned.nextHopsBySessionId[sessionId] ?? []) {
            reachedSessionIds.add(nextHop);
        }
    }
    return reachedSessionIds;
}

function toRtcTopologyFixtureEdgeSet(nextHopsBySessionId: Readonly<Record<string, readonly string[]>>): Set<string> {
    return new Set(
        Object.entries(nextHopsBySessionId).flatMap(([from, nextHops]) => nextHops.map((to) => toRtcTopologyFixtureEdge(from, to)))
    );
}

function toRtcTopologyFixtureEdge(left: string, right: string): string {
    return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/** The smallest room whose replan the real planner rebuilds for each reason. */
export function computeRtcTopologyFixtureRebuild(reason: TopologyReshapeReason): RtcTopologyFixtureReplanned {
    return REBUILD_SCENARIOS[reason]();
}

const ONE_LINK_TREE_OPTIONS: RallarRtcTopologyServiceOptions = { ...RTC_TOPOLOGY_TREE_OPTIONS, degreeLimit: 1, rttReportingDegreeLimit: 1 };

const REBUILD_SCENARIOS: Readonly<Record<TopologyReshapeReason, () => RtcTopologyFixtureReplanned>> = {
    // Four members are below the default tree entry size of five; the fifth member selects a tree.
    'kind-change': () =>
        computeReplan({ options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS, formed: createRtcTopologyFixtureGroup(4) }, (previous) => ({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(5),
            previous
        })),
    // A tree evolves only around a leader it already holds; a joining leader must root a new tree.
    'leader-rooting': () =>
        computeReplan({ options: RTC_TOPOLOGY_TREE_OPTIONS, formed: createRtcTopologyFixtureGroup(6) }, (previous) => ({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group: toRtcTopologyGroupWithDirector(createRtcTopologyFixtureGroup(7), 'peer-7'),
            previous
        })),
    // An eight-member mesh evolves at most max(2, ceil(8 / 4)) = 2 changes at once; three joins exceed it.
    'delta-too-large': () =>
        computeReplan({ options: RTC_TOPOLOGY_MESH_OPTIONS, formed: createRtcTopologyFixtureGroup(8) }, (previous) => ({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(11),
            previous
        })),
    // Under a degree limit of one, the leader-led pair has no session left with a free link, so the
    // leader-first attachment of the third member fails before any graph is validated.
    'update-failed': () =>
        computeReplan({ options: ONE_LINK_TREE_OPTIONS, formed: createRtcTopologyLedFixtureGroup(2) }, (previous) => ({
            options: ONE_LINK_TREE_OPTIONS,
            group: createRtcTopologyLedFixtureGroup(3),
            previous
        })),
    // The six-member tree formed under a degree limit of five has a hub of more than two links; replanned
    // at unchanged membership under a limit of two, the evolved graph is that tree, which the validator rejects.
    'invariant-violation': () =>
        computeReplan({ options: RTC_TOPOLOGY_TREE_OPTIONS, formed: createRtcTopologyFixtureGroup(6) }, (previous) => ({
            options: { ...RTC_TOPOLOGY_TREE_OPTIONS, degreeLimit: 2, rttReportingDegreeLimit: 2 },
            group: createRtcTopologyFixtureGroup(6),
            previous
        })),
    // The formed tree's links measure 200 ms and every other link 10 ms: the rebuild's slowest path is at
    // least 150 ms shorter, past both the quarter and the 10 ms gates.
    refinement: () =>
        computeReplan({ options: RTC_TOPOLOGY_TREE_OPTIONS, formed: createRtcTopologyFixtureGroup(6) }, (previous) => {
            const formedEdges = toRtcTopologyFixtureEdgeSet(previous.nextHopsBySessionId);
            return {
                options: RTC_TOPOLOGY_TREE_OPTIONS,
                group: createRtcTopologyFixtureGroup(6),
                previous,
                planningIntent: 'full-rebuild',
                rttMeasurements: createRtcTopologyFixtureRttMeasurements(
                    createRtcTopologyMemberIds(6),
                    (from, to) => formedEdges.has(toRtcTopologyFixtureEdge(from, to)) ? 200 : 10
                )
            };
        })
};

interface FormedRoom {
    readonly options: RallarRtcTopologyServiceOptions;
    readonly formed: GroupSnapshot;
}

function computeReplan(
    room: FormedRoom,
    toReplanInput: (previous: RallarOverlayTopologySnapshot) => RtcTopologyFixturePlanInput
): RtcTopologyFixtureReplanned {
    const previous = computeRtcTopologyFixturePlan({ options: room.options, group: room.formed, previous: undefined }).snapshot;
    const replanInput = toReplanInput(previous);
    return { previous, planned: computeRtcTopologyFixturePlan(replanInput), replanInput };
}
