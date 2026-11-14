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
 * Which single change can the room owner issue that moves a relay's child to a new parent while the stream origin
 * stays fixed? Three sessions are planned the way the server plans an owner-issued topology change: a work row of kind
 * `group-revision`, planned with the `membership-delta` intent against the stored layout.
 *
 * The change the browser spec drives is the durable topology config write, issued by the room owner (or an admin):
 *   PUT /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/topology/config/requests/:requestId
 *   body {"config":{"topologyKind":"star"}}   (apps/api-v1/src/routes/graph-topology-routes.ts, PUT `config`)
 * The same planner input is reached by POST .../topology/reconfigure/requests/:requestId with
 * {"options":{"topologyKind":"star"}}; that override is transient, the config write is durable.
 */

type RoleName = 'owner' | 'second' | 'third';

type RoleAssignment = Readonly<Record<RoleName, string>>;

type NextHops = Readonly<Record<string, readonly string[]>>;

const ROLE_NAMES: readonly RoleName[] = ['owner', 'second', 'third'];

/** The server defaults of `topology.planning` in apps/api-v1/resources/configuration/defaults-config.json. */
const SERVER_DEFAULTS: RallarRtcTopologyServiceOptions = {
    topologyKind: 'auto',
    degreeLimit: 5,
    treeMinSize: 5,
    meshMinSize: 16,
    meshParamK: 2,
    meshExitWidth: 4,
    treeExitWidth: 0,
    rttReportingDegreeLimit: 5
};

const SORTED_SESSION_IDS = ['session-a', 'session-b', 'session-c'] as const;

/** Every assignment of owner, second and third browser (join order) to the three sorted session ids. */
const ROLE_ASSIGNMENTS: readonly RoleAssignment[] = SORTED_SESSION_IDS.flatMap((owner) =>
    SORTED_SESSION_IDS.filter((second) => second !== owner).map((second) => ({
        owner,
        second,
        third: SORTED_SESSION_IDS.find((id) => id !== owner && id !== second)!
    }))
);

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
    const group = createRtcTopologyGroupSnapshot('relay-reparenting', [
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

/** The neighbour a session receives the origin's frames from: the next hop on the path back to the origin. */
function readParentSessionId(nextHops: NextHops, origin: string, sessionId: string): string | undefined {
    const parentBySessionId = new Map<string, string>();
    const frontier = [origin];
    for (const current of frontier) {
        for (const neighbour of nextHops[current] ?? []) {
            if (neighbour !== origin && !parentBySessionId.has(neighbour)) {
                parentBySessionId.set(neighbour, current);
                frontier.push(neighbour);
            }
        }
    }
    return parentBySessionId.get(sessionId);
}

function readMovedChildren(before: NextHops, after: NextHops, origin: string): readonly string[] {
    return SORTED_SESSION_IDS.filter((sessionId) =>
        sessionId !== origin && readParentSessionId(before, origin, sessionId) !== readParentSessionId(after, origin, sessionId)
    );
}

/** In a three-node tree the relay is the one session with two neighbours. */
function readRelaySessionId(nextHops: NextHops): string {
    const relays = SORTED_SESSION_IDS.filter((sessionId) => nextHops[sessionId]?.length === 2);
    expect(relays).toHaveLength(1);
    return relays[0]!;
}

function toRolesWhere(roles: RoleAssignment, predicate: (sessionId: string) => boolean): readonly RoleName[] {
    return ROLE_NAMES.filter((role) => predicate(roles[role]));
}

function planStarThenTree(roles: RoleAssignment, rttMeasurements?: readonly RttMeasurementInfo[]) {
    const star = planRoom({ roles, config: {}, rttMeasurements });
    const tree = planRoom({ roles, config: { topologyKind: 'tree' }, previous: star.snapshot, rttMeasurements });
    return { star, tree };
}

describe('RTC topology: the owner-issued topologyKind change that moves a relay child (three sessions)', () => {
    describe.each(ROLE_ASSIGNMENTS)('owner $owner, second $second, third $third', (roles) => {
        const { star, tree } = planStarThenTree(roles);
        const relaySessionId = readRelaySessionId(tree.snapshot.nextHopsBySessionId);
        const originRoles = toRolesWhere(roles, (sessionId) => sessionId !== relaySessionId);

        it('plans a complete graph under auto and a path through one relay once the owner sets topologyKind tree', () => {
            expect(star.snapshot.topology).toBe('star');
            expect(star.snapshot.nextHopsBySessionId[roles.owner]).toEqual(
                SORTED_SESSION_IDS.filter((id) => id !== roles.owner)
            );
            expect(tree.snapshot.topology).toBe('tree');
            expect(relaySessionId).toBe('session-c');
        });

        it.each(originRoles)(
            'moves the other leaf from the relay to the origin when the room owner sets topologyKind star, origin %s',
            (originRole) => {
                const origin = roles[originRole];
                const child = SORTED_SESSION_IDS.find((id) => id !== origin && id !== relaySessionId)!;

                const afterStar = planRoom({ roles, config: { topologyKind: 'star' }, previous: tree.snapshot });

                expect(afterStar.changed).toBe(true);
                expect(readParentSessionId(tree.snapshot.nextHopsBySessionId, origin, child)).toBe(relaySessionId);
                expect(readParentSessionId(afterStar.snapshot.nextHopsBySessionId, origin, child)).toBe(origin);
                expect(readMovedChildren(
                    tree.snapshot.nextHopsBySessionId,
                    afterStar.snapshot.nextHopsBySessionId,
                    origin
                )).toEqual([child]);
            }
        );

        it('moves no child when the stream origin is itself the relay, so the origin must be chosen from the tree', () => {
            const afterStar = planRoom({ roles, config: { topologyKind: 'star' }, previous: tree.snapshot });

            expect(readMovedChildren(
                tree.snapshot.nextHopsBySessionId,
                afterStar.snapshot.nextHopsBySessionId,
                relaySessionId
            )).toEqual([]);
        });
    });

    it.each(ROLE_NAMES)(
        'moves a child in exactly four of the six role assignments when the origin is fixed to the %s browser',
        (originRole) => {
            const movedByAssignment = ROLE_ASSIGNMENTS.map((roles) => {
                const { tree } = planStarThenTree(roles);
                const afterStar = planRoom({ roles, config: { topologyKind: 'star' }, previous: tree.snapshot });
                return {
                    relayIsOrigin: readRelaySessionId(tree.snapshot.nextHopsBySessionId) === roles[originRole],
                    moved: readMovedChildren(
                        tree.snapshot.nextHopsBySessionId,
                        afterStar.snapshot.nextHopsBySessionId,
                        roles[originRole]
                    )
                };
            });

            expect(movedByAssignment.filter((entry) => entry.moved.length === 0)).toHaveLength(2);
            expect(movedByAssignment.filter((entry) => entry.moved.length === 0).every((entry) => entry.relayIsOrigin))
                .toBe(true);
            expect(movedByAssignment.filter((entry) => entry.moved.length === 1)).toHaveLength(4);
        }
    );

    it.each(ROLE_ASSIGNMENTS)(
        'follows the two fastest reported links to the relay for owner $owner, second $second, third $third',
        (roles) => {
            const rttMeasurements = [
                createRtcTopologyRttMeasurement({ sessionIdFrom: roles.owner, sessionIdTo: roles.second, rttMs: 2, version: 1 }),
                createRtcTopologyRttMeasurement({ sessionIdFrom: roles.owner, sessionIdTo: roles.third, rttMs: 3, version: 2 }),
                createRtcTopologyRttMeasurement({ sessionIdFrom: roles.second, sessionIdTo: roles.third, rttMs: 40, version: 3 })
            ];
            const { tree } = planStarThenTree(roles, rttMeasurements);

            const afterStar = planRoom({
                roles,
                config: { topologyKind: 'star' },
                previous: tree.snapshot,
                rttMeasurements
            });

            expect(readRelaySessionId(tree.snapshot.nextHopsBySessionId)).toBe(roles.owner);
            expect(readMovedChildren(
                tree.snapshot.nextHopsBySessionId,
                afterStar.snapshot.nextHopsBySessionId,
                roles.second
            )).toEqual([roles.third]);
            expect(readParentSessionId(tree.snapshot.nextHopsBySessionId, roles.second, roles.third)).toBe(roles.owner);
            expect(readParentSessionId(afterStar.snapshot.nextHopsBySessionId, roles.second, roles.third)).toBe(
                roles.second
            );
        }
    );
});

describe('RTC topology: owner-issued changes that keep every edge of a three-session tree', () => {
    it.each(ROLE_ASSIGNMENTS)(
        'keeps the tree when the director moves between any two sessions, owner $owner, second $second, third $third',
        (roles) => {
            const { tree } = planStarThenTree(roles);

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

                    expect(moved.snapshot.nextHopsBySessionId).toEqual(tree.snapshot.nextHopsBySessionId);
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

            expect(raised.snapshot.nextHopsBySessionId).toEqual(limited.snapshot.nextHopsBySessionId);
            expect(readMovedChildren(
                limited.snapshot.nextHopsBySessionId,
                raised.snapshot.nextHopsBySessionId,
                roles.owner
            )).toEqual([]);
        }
    );
});
