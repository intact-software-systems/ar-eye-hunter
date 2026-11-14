import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RtcTopologyPlanner } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import type { RallarRtcTopologyServiceOptions } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

import {
    createRtcTopologyGroupSnapshot,
    createRtcTopologyRttMeasurement,
    toRtcTopologyGroupWithDirector
} from '../rtc-topology-test-fixtures.ts';

/*
 * Which single change can the room owner issue that changes the edges around a relay while a stream origin stays
 * fixed? A browser reads its own neighbour set (`nextHopsBySessionId[self]`) to dial, forward and admit, so the
 * layouts are compared as undirected edge sets, planned the way the server plans an owner-issued config change: a
 * `group-revision` work row, planned with the `membership-delta` intent against the stored layout.
 *
 * The live-RTC matrix driver forms the room with the durable config { topologyKind: 'mesh', degreeLimit: 2 }, which
 * for three sessions is a complete graph. The owner then writes, in this order:
 *   1. { "config": { "topologyKind": "tree" } }  the break side: the edge between the two leaves leaves the layout
 *   2. { "config": { "topologyKind": "star" } }  the add side: that edge is added back, nothing leaves
 * Route (apps/api-v1/src/routes/graph-topology-routes.ts, PUT `config`, owner or admin only):
 *   PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config/requests/:requestId
 * The PUT replaces the whole durable config, so the tree write drops degreeLimit 2 and plans with the server default.
 */

type RoleName = 'owner' | 'second' | 'third';

type RoleAssignment = Readonly<Record<RoleName, string>>;

type NextHops = Readonly<Record<string, readonly string[]>>;

interface EdgeDifference {
    readonly added: readonly string[];
    readonly removed: readonly string[];
}

const ROLE_NAMES: readonly RoleName[] = ['owner', 'second', 'third'];

const SERVER_DEFAULTS: RallarRtcTopologyServiceOptions = readServerPlanningDefaults();

/** What the live-RTC matrix driver's owner writes before the room forms. */
const MATRIX_ROOM_CONFIG: Partial<RallarRtcTopologyServiceOptions> = { topologyKind: 'mesh', degreeLimit: 2 };

const SORTED_SESSION_IDS = ['session-a', 'session-b', 'session-c'] as const;

/** Every assignment of owner, second and third browser (join order) to the three sorted session ids. */
const ROLE_ASSIGNMENTS: readonly RoleAssignment[] = SORTED_SESSION_IDS.flatMap((owner) =>
    SORTED_SESSION_IDS.filter((second) => second !== owner).map((second) => ({
        owner,
        second,
        third: SORTED_SESSION_IDS.find((id) => id !== owner && id !== second)!
    }))
);

function readServerPlanningDefaults(): RallarRtcTopologyServiceOptions {
    const path = fileURLToPath(
        new URL('../../../../../../apps/api-v1/resources/configuration/defaults-config.json', import.meta.url)
    );
    const planning = (JSON.parse(readFileSync(path, 'utf8')) as {
        readonly topology: { readonly planning: RallarRtcTopologyServiceOptions; };
    }).topology.planning;
    return {
        topologyKind: planning.topologyKind,
        degreeLimit: planning.degreeLimit,
        treeMinSize: planning.treeMinSize,
        meshMinSize: planning.meshMinSize,
        meshParamK: planning.meshParamK,
        meshExitWidth: planning.meshExitWidth,
        treeExitWidth: planning.treeExitWidth,
        rttReportingDegreeLimit: planning.rttReportingDegreeLimit
    };
}

interface PlanRoomInput {
    readonly roles: RoleAssignment;
    readonly config: Partial<RallarRtcTopologyServiceOptions>;
    readonly previous?: RallarOverlayTopologySnapshot;
    readonly directorSessionId?: string;
    readonly rttMeasurements?: readonly RttMeasurementInfo[];
}

function planRoom(input: PlanRoomInput) {
    const effective = { ...SERVER_DEFAULTS, ...input.config };
    const planner = new RtcTopologyPlanner(effective, { metrics: new RtcTopologyMetrics(), durationNowMs: () => 0 });
    const group = createRtcTopologyGroupSnapshot('relay-edges', [
        input.roles.owner,
        input.roles.second,
        input.roles.third
    ]);
    return planner.plan({
        group: input.directorSessionId === undefined
            ? group
            : toRtcTopologyGroupWithDirector(group, input.directorSessionId),
        rttMeasurements: input.rttMeasurements ?? [],
        previous: input.previous,
        updateOptions: { previous: input.previous, topologyOptions: effective, planningIntent: 'membership-delta' },
        nowEpochMs: 1_000
    });
}

function toEdges(nextHops: NextHops): readonly string[] {
    return Object.entries(nextHops)
        .flatMap(([sessionId, neighbours]) => neighbours.map((neighbour) => [sessionId, neighbour].sort().join(' - ')))
        .filter((edge, index, edges) => edges.indexOf(edge) === index)
        .sort();
}

function toEdge(left: string, right: string): string {
    return [left, right].sort().join(' - ');
}

function diffEdges(before: NextHops, after: NextHops): EdgeDifference {
    const beforeEdges = toEdges(before);
    const afterEdges = toEdges(after);
    return {
        added: afterEdges.filter((edge) => !beforeEdges.includes(edge)),
        removed: beforeEdges.filter((edge) => !afterEdges.includes(edge))
    };
}

/** In a three-node tree the relay is the one session with two neighbours. */
function readRelaySessionId(nextHops: NextHops): string {
    const relays = SORTED_SESSION_IDS.filter((sessionId) => nextHops[sessionId]?.length === 2);
    expect(relays).toHaveLength(1);
    return relays[0]!;
}

function planMatrixRoom(roles: RoleAssignment, rttMeasurements?: readonly RttMeasurementInfo[]) {
    return planRoom({ roles, config: MATRIX_ROOM_CONFIG, rttMeasurements });
}

function planTreeConfig(
    roles: RoleAssignment,
    previous: RallarOverlayTopologySnapshot,
    rttMeasurements?: readonly RttMeasurementInfo[]
) {
    return planRoom({ roles, config: { topologyKind: 'tree' }, previous, rttMeasurements });
}

function toRttReports(roles: RoleAssignment): readonly RttMeasurementInfo[] {
    return [
        createRtcTopologyRttMeasurement({ sessionIdFrom: roles.owner, sessionIdTo: roles.second, rttMs: 2, version: 1 }),
        createRtcTopologyRttMeasurement({ sessionIdFrom: roles.owner, sessionIdTo: roles.third, rttMs: 3, version: 2 }),
        createRtcTopologyRttMeasurement({ sessionIdFrom: roles.second, sessionIdTo: roles.third, rttMs: 40, version: 3 })
    ];
}

describe('RTC topology: the owner-issued tree and star configs of a matrix-driver room (three sessions)', () => {
    it('plans the relay of the no-RTT tree as session-c for the fixture ids, whatever the role assignment', () => {
        const relays = ROLE_ASSIGNMENTS.map((roles) => {
            const matrixRoom = planMatrixRoom(roles).snapshot;
            return readRelaySessionId(planTreeConfig(roles, matrixRoom).snapshot.nextHopsBySessionId);
        });

        expect(relays).toEqual(ROLE_ASSIGNMENTS.map(() => 'session-c'));
    });

    describe.each(ROLE_ASSIGNMENTS)('owner $owner, second $second, third $third', (roles) => {
        const matrix = planMatrixRoom(roles);

        it('plans a complete graph of three edges under the matrix driver config', () => {
            expect(matrix.snapshot.topology).toBe('mesh');
            expect(toEdges(matrix.snapshot.nextHopsBySessionId)).toEqual([
                'session-a - session-b',
                'session-a - session-c',
                'session-b - session-c'
            ]);
        });

        it.each([
            { reports: 'without RTT reports', rttMeasurements: undefined },
            { reports: 'with RTT reports', rttMeasurements: toRttReports(roles) }
        ])(
            'removes exactly the edge between the two leaves and adds none when the owner writes the tree config, $reports',
            ({ rttMeasurements }) => {
                const complete = planMatrixRoom(roles, rttMeasurements);

                const tree = planTreeConfig(roles, complete.snapshot, rttMeasurements);

                const relay = readRelaySessionId(tree.snapshot.nextHopsBySessionId);
                const leaves = SORTED_SESSION_IDS.filter((sessionId) => sessionId !== relay);
                expect(tree.snapshot.topology).toBe('tree');
                expect(diffEdges(complete.snapshot.nextHopsBySessionId, tree.snapshot.nextHopsBySessionId)).toEqual({
                    added: [],
                    removed: [toEdge(leaves[0]!, leaves[1]!)]
                });
                if (rttMeasurements !== undefined) {
                    expect(relay).toBe(roles.owner);
                }
            }
        );

        it('adds exactly the edge between the two leaves and removes none when the owner then writes the star config', () => {
            const tree = planTreeConfig(roles, matrix.snapshot);
            const leaves = SORTED_SESSION_IDS.filter(
                (sessionId) => sessionId !== readRelaySessionId(tree.snapshot.nextHopsBySessionId)
            );

            const star = planRoom({ roles, config: { topologyKind: 'star' }, previous: tree.snapshot });

            expect(star.snapshot.topology).toBe('star');
            expect(diffEdges(tree.snapshot.nextHopsBySessionId, star.snapshot.nextHopsBySessionId)).toEqual({
                added: [toEdge(leaves[0]!, leaves[1]!)],
                removed: []
            });
        });

        it('takes a leaf origin\'s direct edge to the other leaf away and leaves a relay origin both of its edges', () => {
            const tree = planTreeConfig(roles, matrix.snapshot);
            const relay = readRelaySessionId(tree.snapshot.nextHopsBySessionId);

            for (const origin of SORTED_SESSION_IDS) {
                const before = [...matrix.snapshot.nextHopsBySessionId[origin]!];
                const after = [...tree.snapshot.nextHopsBySessionId[origin]!];
                expect(before).toHaveLength(2);
                expect(after).toEqual(origin === relay ? before : [relay]);
            }
        });
    });
});

describe('RTC topology: owner-issued changes that keep every edge of a three-session tree', () => {
    it.each(ROLE_ASSIGNMENTS)(
        'keeps the tree when the director moves between any two sessions, owner $owner, second $second, third $third',
        (roles) => {
            const tree = planTreeConfig(roles, planMatrixRoom(roles).snapshot);

            for (const from of SORTED_SESSION_IDS) {
                for (const to of SORTED_SESSION_IDS.filter((id) => id !== from)) {
                    const rooted = planRoom({
                        roles,
                        config: { topologyKind: 'tree' },
                        previous: tree.snapshot,
                        directorSessionId: from
                    });
                    const moved = planRoom({
                        roles,
                        config: { topologyKind: 'tree' },
                        previous: rooted.snapshot,
                        directorSessionId: to
                    });

                    expect(diffEdges(tree.snapshot.nextHopsBySessionId, moved.snapshot.nextHopsBySessionId)).toEqual({
                        added: [],
                        removed: []
                    });
                }
            }
        }
    );

    it.each(ROLE_ASSIGNMENTS)(
        'keeps the tree when degreeLimit grows from 2 to 3, owner $owner, second $second, third $third',
        (roles) => {
            const limited = planRoom({ roles, config: { topologyKind: 'tree', degreeLimit: 2 } });

            const raised = planRoom({
                roles,
                config: { topologyKind: 'tree', degreeLimit: 3 },
                previous: limited.snapshot
            });

            expect(diffEdges(limited.snapshot.nextHopsBySessionId, raised.snapshot.nextHopsBySessionId)).toEqual({
                added: [],
                removed: []
            });
        }
    );
});

/*
 * Can two owner config writes make the planner re-parent one of FOUR sessions onto an edge that the first write's
 * layout does not have? Write 1 must leave sessions X and Y without an edge; write 2 must add X - Y and drop an edge
 * of Y's. The edges come from hash weights of the session ids (or from RTT reports), so the same two writes
 * re-parent a session for one id set and move nothing for another.
 */

interface PlanSessionsInput {
    readonly sessionIds: readonly string[];
    readonly config: Partial<RallarRtcTopologyServiceOptions>;
    readonly previous?: RallarOverlayTopologySnapshot;
    readonly rttMeasurements?: readonly RttMeasurementInfo[];
}

const FOUR_SESSION_WRITE_1: Partial<RallarRtcTopologyServiceOptions> = {
    topologyKind: 'mesh',
    degreeLimit: 2,
    meshParamK: 1
};

/** The tree config replaces write 1 whole, so it plans with the server's default degree limit. */
const FOUR_SESSION_WRITE_2: Partial<RallarRtcTopologyServiceOptions> = { topologyKind: 'tree' };

const FIXTURE_FOUR_SESSION_IDS = ['session-a', 'session-b', 'session-c', 'session-d'] as const;

const OTHER_FOUR_SESSION_IDS = ['session-a1', 'session-b1', 'session-c1', 'session-d1'] as const;

function planSessions(input: PlanSessionsInput) {
    const effective = { ...SERVER_DEFAULTS, ...input.config };
    const planner = new RtcTopologyPlanner(effective, { metrics: new RtcTopologyMetrics(), durationNowMs: () => 0 });
    return planner.plan({
        group: createRtcTopologyGroupSnapshot('re-parent', input.sessionIds),
        rttMeasurements: input.rttMeasurements ?? [],
        previous: input.previous,
        updateOptions: { previous: input.previous, topologyOptions: effective, planningIntent: 'membership-delta' },
        nowEpochMs: 1_000
    }).snapshot;
}

function planFourSessionWrites(sessionIds: readonly string[], rttMeasurements?: readonly RttMeasurementInfo[]) {
    const complete = planSessions({ sessionIds, config: { topologyKind: 'star' }, rttMeasurements });
    const first = planSessions({ sessionIds, config: FOUR_SESSION_WRITE_1, previous: complete, rttMeasurements });
    const second = planSessions({ sessionIds, config: FOUR_SESSION_WRITE_2, previous: first, rttMeasurements });
    return { first, second };
}

function toFourSessionRttReports(sessionIds: readonly string[]): readonly RttMeasurementInfo[] {
    return sessionIds.flatMap((from, fromIndex) =>
        sessionIds.slice(fromIndex + 1).map((to, toIndex) =>
            createRtcTopologyRttMeasurement({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: 5 + 7 * fromIndex + 3 * toIndex,
                version: fromIndex * sessionIds.length + toIndex + 1
            })
        )
    );
}

describe('RTC topology: owner config writes that re-parent one of four sessions', () => {
    it('leaves the fourth session without an edge under the matrix driver config', () => {
        const matrix = planSessions({ sessionIds: FIXTURE_FOUR_SESSION_IDS, config: MATRIX_ROOM_CONFIG });

        expect(toEdges(matrix.nextHopsBySessionId)).toEqual([
            'session-a - session-b',
            'session-a - session-c',
            'session-b - session-c'
        ]);
    });

    it('adds session-c - session-d, an edge write 1 did not have, and drops session-a - session-b for the fixture ids', () => {
        const { first, second } = planFourSessionWrites(FIXTURE_FOUR_SESSION_IDS);

        expect(toEdges(first.nextHopsBySessionId)).toEqual([
            'session-a - session-b',
            'session-a - session-d',
            'session-b - session-c'
        ]);
        expect(diffEdges(first.nextHopsBySessionId, second.nextHopsBySessionId)).toEqual({
            added: ['session-c - session-d'],
            removed: ['session-a - session-b']
        });
    });

    it('moves no edge with the same two writes for another id set', () => {
        const { first, second } = planFourSessionWrites(OTHER_FOUR_SESSION_IDS);

        expect(diffEdges(first.nextHopsBySessionId, second.nextHopsBySessionId)).toEqual({ added: [], removed: [] });
    });

    it('moves session-d from session-b onto session-a instead for the fixture ids once RTT reports exist', () => {
        const { first, second } = planFourSessionWrites(
            FIXTURE_FOUR_SESSION_IDS,
            toFourSessionRttReports(FIXTURE_FOUR_SESSION_IDS)
        );

        expect(toEdges(first.nextHopsBySessionId)).toEqual([
            'session-a - session-b',
            'session-a - session-c',
            'session-b - session-d'
        ]);
        expect(diffEdges(first.nextHopsBySessionId, second.nextHopsBySessionId)).toEqual({
            added: ['session-a - session-d'],
            removed: ['session-b - session-d']
        });
    });
});
