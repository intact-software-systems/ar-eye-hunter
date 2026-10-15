import { describe, expect, it } from 'vitest';

import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { planRallarRtcTopologySnapshot } from '@shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts';
import { RtcTopologyPlanner } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';

import {
    computeRtcTopologyHopEccentricity,
    computeRtcTopologyHopRadius,
    createCentralRtcTopologyRttMeasurements,
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement,
    toRtcTopologyGroupWithDirector
} from '../rtc-topology-test-fixtures.ts';

describe('RTC topology planning options and revisions', () => {
    it('plans a star topology through the dedicated planning owner', () => {
        const planner = new RtcTopologyPlanner({ topologyKind: 'star' }, { metrics: new RtcTopologyMetrics(), durationNowMs: () => 0 });

        const result = planner.plan({
            group: createRtcTopologyGroupSnapshot('planner-owner', createRtcTopologyMemberIds(3)),
            rttMeasurements: [],
            previous: undefined,
            updateOptions: {},
            nowEpochMs: 100
        });

        expect(result.snapshot.topology).toBe('star');
    });

    it('owns no-RTT tree, weighted tree, and per-update topology decisions', () => {
        const metrics = new RtcTopologyMetrics();
        const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5 }, { metrics, durationNowMs: () => 0 });
        const group = createRtcTopologyGroupSnapshot('planner-owner', createRtcTopologyMemberIds(5));

        const noRtt = planner.plan({
            group,
            rttMeasurements: [],
            previous: undefined,
            updateOptions: {},
            nowEpochMs: 100
        });
        const weighted = planner.plan({
            group,
            rttMeasurements: createCentralRtcTopologyRttMeasurements(createRtcTopologyMemberIds(5), 'peer-1'),
            previous: noRtt.snapshot,
            updateOptions: { topologyOptions: { topologyKind: 'mesh', degreeLimit: 2 } },
            nowEpochMs: 200
        });

        expect(noRtt.snapshot.topology).toBe('tree');
        expect(weighted.snapshot.topology).toBe('mesh');
        expect(weighted.snapshot.degreeLimit).toBe(2);
        expect(metrics.read(0)).toMatchObject({
            topologyUpdateCount: 0,
            updatesWithoutRttMeasurementCount: 1,
            updatesWithRttMeasurementCount: 1,
            topologyChangedCount: 2,
            noRttTreePlanCount: 1,
            weightedPlanCount: 1,
            weightedRoomGraphBuildCount: 1
        });
    });

    it('roots a weighted tree at the appointed director', () => {
        const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 15 }, {
            metrics: new RtcTopologyMetrics(),
            durationNowMs: () => 0
        });
        const memberSessionIds = createRtcTopologyMemberIds(16);
        const group = toRtcTopologyGroupWithDirector(
            createRtcTopologyGroupSnapshot('planner-director', memberSessionIds),
            'peer-12'
        );

        const planned = planner.plan({
            group,
            rttMeasurements: createCentralRtcTopologyRttMeasurements(memberSessionIds, 'no-central-session'),
            previous: undefined,
            updateOptions: {},
            nowEpochMs: 100
        });

        const nextHopsBySessionId = planned.snapshot.nextHopsBySessionId;
        expect(nextHopsBySessionId['peer-12']).toHaveLength(5);
        expect(computeRtcTopologyHopEccentricity(nextHopsBySessionId, 'peer-12')).toBe(2);
        expect(computeRtcTopologyHopRadius(nextHopsBySessionId)).toBe(2);
    });

    it.each([15, 30, 50])(
        'keeps every director of %i members at most as deep after an RTT rebuild over tree-edge reports as the no-RTT tree rooted at it',
        (memberCount) => {
            const memberSessionIds = createRtcTopologyMemberIds(memberCount);
            const deeperDirectors = memberSessionIds.filter((directorSessionId) => {
                const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 5 }, {
                    metrics: new RtcTopologyMetrics(),
                    durationNowMs: () => 0
                });
                const group = toRtcTopologyGroupWithDirector(
                    createRtcTopologyGroupSnapshot('planner-reported-tree', memberSessionIds),
                    directorSessionId
                );
                const rooted = planner.plan({ group, rttMeasurements: [], previous: undefined, updateOptions: {}, nowEpochMs: 100 });
                const weighted = planner.plan({
                    group,
                    rttMeasurements: createTreeEdgeRttMeasurements(rooted.snapshot.nextHopsBySessionId),
                    previous: rooted.snapshot,
                    updateOptions: {},
                    nowEpochMs: 200
                });
                return computeRtcTopologyHopEccentricity(weighted.snapshot.nextHopsBySessionId, directorSessionId) >
                    computeRtcTopologyHopEccentricity(rooted.snapshot.nextHopsBySessionId, directorSessionId);
            });

            expect(deeperDirectors).toEqual([]);
        }
    );

    it.each([15, 30, 50])(
        'roots the seed of a sparse reported graph of %i members at the director, so the weighted plan keeps it as shallow as the no-RTT tree',
        (memberCount) => {
            const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 5 }, {
                metrics: new RtcTopologyMetrics(),
                durationNowMs: () => 0
            });
            const memberSessionIds = createRtcTopologyMemberIds(memberCount);
            const directorSessionId = memberSessionIds[Math.floor(memberCount / 2)]!;
            const group = toRtcTopologyGroupWithDirector(
                createRtcTopologyGroupSnapshot('planner-sparse-reports', memberSessionIds),
                directorSessionId
            );
            const rooted = planner.plan({ group, rttMeasurements: [], previous: undefined, updateOptions: {}, nowEpochMs: 100 });

            const weighted = planner.plan({
                group,
                rttMeasurements: createSaturatedCliqueRttMeasurements(memberSessionIds, 6),
                previous: rooted.snapshot,
                updateOptions: {},
                nowEpochMs: 200
            });

            expect(computeRtcTopologyHopEccentricity(weighted.snapshot.nextHopsBySessionId, directorSessionId))
                .toBeLessThanOrEqual(computeRtcTopologyHopEccentricity(rooted.snapshot.nextHopsBySessionId, directorSessionId));
        }
    );

    it('rebuilds a weighted membership-delta plan around a director appointed deeper than the tree rooted at it', () => {
        const metrics = new RtcTopologyMetrics();
        const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 15 }, { metrics, durationNowMs: () => 0 });
        const memberSessionIds = createRtcTopologyMemberIds(16);
        const rttMeasurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'no-central-session');
        const leaderless = createRtcTopologyGroupSnapshot('planner-appointment', memberSessionIds);
        const accepted = planner.plan({
            group: leaderless,
            rttMeasurements,
            previous: undefined,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 100
        });

        const appointed = planner.plan({
            group: toRtcTopologyGroupWithDirector(leaderless, 'peer-6'),
            rttMeasurements,
            previous: accepted.snapshot,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 200
        });

        expect(computeRtcTopologyHopEccentricity(accepted.snapshot.nextHopsBySessionId, 'peer-6')).toBeGreaterThan(2);
        expect(appointed.changed).toBe(true);
        expect(appointed.snapshot.nextHopsBySessionId['peer-6']).toHaveLength(5);
        expect(computeRtcTopologyHopEccentricity(appointed.snapshot.nextHopsBySessionId, 'peer-6')).toBe(2);
        expect(metrics.read(0)).toMatchObject({ incrementalPlanCount: 0, incrementalPlanFallbackFullCount: 1 });
    });

    it('rebuilds a membership-delta plan rooted at a director who joins with the delta', () => {
        const metrics = new RtcTopologyMetrics();
        const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5 }, { metrics, durationNowMs: () => 0 });
        const memberSessionIds = createRtcTopologyMemberIds(17);
        const accepted = planner.plan({
            group: createRtcTopologyGroupSnapshot('planner-director-join', memberSessionIds.slice(0, 16)),
            rttMeasurements: [],
            previous: undefined,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 100
        });
        const joined = toRtcTopologyGroupWithDirector(
            createRtcTopologyGroupSnapshot('planner-director-join', memberSessionIds),
            'peer-17'
        );

        const planned = planner.plan({
            group: joined,
            rttMeasurements: [],
            previous: accepted.snapshot,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 200
        });
        const rooted = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5 }, { metrics: new RtcTopologyMetrics(), durationNowMs: () => 0 })
            .plan({ group: joined, rttMeasurements: [], previous: undefined, updateOptions: {}, nowEpochMs: 200 });

        expect(metrics.read(0)).toMatchObject({ incrementalPlanCount: 0, incrementalPlanFallbackFullCount: 1 });
        expect(planned.snapshot.nextHopsBySessionId).toEqual(rooted.snapshot.nextHopsBySessionId);
    });

    it('leaves a rebuilt director-rooted tree unchanged when it is planned again', () => {
        const planner = new RtcTopologyPlanner({ topologyKind: 'tree', degreeLimit: 5, rttReportingDegreeLimit: 5 }, {
            metrics: new RtcTopologyMetrics(),
            durationNowMs: () => 0
        });
        const memberSessionIds = createRtcTopologyMemberIds(30);
        const group = toRtcTopologyGroupWithDirector(
            createRtcTopologyGroupSnapshot('planner-replan', memberSessionIds),
            'peer-15'
        );
        const rttMeasurements = createSaturatedCliqueRttMeasurements(memberSessionIds, 6);
        const first = planner.plan({
            group,
            rttMeasurements,
            previous: undefined,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 100
        });

        const second = planner.plan({
            group,
            rttMeasurements,
            previous: first.snapshot,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 200
        });

        expect(second.changed).toBe(false);
        expect(second.snapshot.nextHopsBySessionId).toEqual(first.snapshot.nextHopsBySessionId);
    });

    it('records direct incremental planning, ordinary fallback, and hysteresis hold', () => {
        const metrics = new RtcTopologyMetrics();
        const planner = new RtcTopologyPlanner({}, { metrics, durationNowMs: () => 0 });
        const memberSessionIds = createRtcTopologyMemberIds(20);
        const formed = planner.plan({
            group: createRtcTopologyGroupSnapshot('planner-incremental', memberSessionIds),
            rttMeasurements: [],
            previous: undefined,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 100
        });
        const incrementallyPlanned = planner.plan({
            group: createRtcTopologyGroupSnapshot('planner-incremental', [...memberSessionIds, 'peer-21']),
            rttMeasurements: [],
            previous: formed.snapshot,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 200
        });
        const ordinaryFallback = planner.plan({
            group: createRtcTopologyGroupSnapshot('planner-incremental', [
                ...memberSessionIds.slice(0, 10),
                ...createRtcTopologyMemberIds(10).map((sessionId) => `${sessionId}-replacement`)
            ]),
            rttMeasurements: [],
            previous: formed.snapshot,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 300
        });
        expect(incrementallyPlanned.snapshot.topology).toBe('mesh');
        expect(ordinaryFallback.snapshot.topology).toBe('mesh');
        expect(metrics.read(0)).toMatchObject({
            incrementalPlanCount: 1,
            incrementalPlanFallbackFullCount: 1,
            incrementalPlanInvariantFallbackCount: 0
        });

        const hysteresisMetrics = new RtcTopologyMetrics();
        const hysteresisPlanner = new RtcTopologyPlanner({}, { metrics: hysteresisMetrics, durationNowMs: () => 0 });
        const meshMembers = createRtcTopologyMemberIds(16);
        const meshPlan = hysteresisPlanner.plan({
            group: createRtcTopologyGroupSnapshot('planner-hysteresis', meshMembers),
            rttMeasurements: [],
            previous: undefined,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 300
        });
        const heldKind = hysteresisPlanner.plan({
            group: createRtcTopologyGroupSnapshot('planner-hysteresis', meshMembers.slice(0, 13)),
            rttMeasurements: [],
            previous: meshPlan.snapshot,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 400
        });

        expect(heldKind.snapshot.topology).toBe('mesh');
        expect(hysteresisMetrics.read(0)).toMatchObject({
            incrementalPlanCount: 0,
            incrementalPlanFallbackFullCount: 1,
            hysteresisHeldKindCount: 1
        });
    });

    it('records a direct invariant fallback when a tree removal cannot validate', () => {
        const metrics = new RtcTopologyMetrics();
        const planner = new RtcTopologyPlanner({}, { metrics, durationNowMs: () => 0 });
        const memberSessionIds = createRtcTopologyMemberIds(8);
        const formed = planner.plan({
            group: createRtcTopologyGroupSnapshot('planner-invariant', memberSessionIds),
            rttMeasurements: [],
            previous: undefined,
            updateOptions: { planningIntent: 'membership-delta' },
            nowEpochMs: 100
        });

        for (const sessionId of memberSessionIds) {
            planner.plan({
                group: createRtcTopologyGroupSnapshot(
                    'planner-invariant',
                    memberSessionIds.filter((candidate) => candidate !== sessionId)
                ),
                rttMeasurements: [],
                previous: formed.snapshot,
                updateOptions: { planningIntent: 'membership-delta' },
                nowEpochMs: 200
            });
        }

        expect(metrics.read(0)).toMatchObject({
            incrementalPlanInvariantFallbackCount: expect.any(Number),
            incrementalPlanFallbackFullCount: expect.any(Number)
        });
        expect(metrics.read(0).incrementalPlanInvariantFallbackCount).toBeGreaterThan(0);
    });

    it('honors request topology kind override for star topology', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(8));
        const service = new RallarRtcTopologyService({ now: () => 100 });

        const result = service.updateGroupTopology(group, [], {
            topologyOptions: { topologyKind: 'star' }
        });

        expect(result.snapshot.topology).toBe('star');
        expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual(['peer-2', 'peer-3', 'peer-4', 'peer-5', 'peer-6', 'peer-7', 'peer-8']);
    });

    it('honors request topology kind override for tree topology', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(4));
        const service = new RallarRtcTopologyService({ now: () => 100 });

        const result = service.updateGroupTopology(group, [], {
            topologyOptions: { topologyKind: 'tree' }
        });

        expect(result.snapshot.topology).toBe('tree');
        for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
            expect(nextHops.length).toBeLessThanOrEqual(5);
        }
    });

    it('honors mesh override when the group supports mesh', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(16));
        const service = new RallarRtcTopologyService({ now: () => 100, meshMinSize: 999 });

        const result = service.updateGroupTopology(group, [], {
            topologyOptions: { topologyKind: 'mesh' }
        });

        expect(result.snapshot.topology).toBe('mesh');
        const validation = validateGroupTopologyNextHops({
            activeSessionIds: new Set(result.snapshot.activeSessionIds),
            nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
            maxDegree: result.snapshot.degreeLimit
        });
        expect(validation.issues).toEqual([]);
    });

    it('uses per-update degree limit without replacing service-wide defaults', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(8));
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: 5,
            meshMinSize: 999
        });

        const constrained = service.updateGroupTopology(group, [], {
            topologyOptions: { degreeLimit: 2 }
        });
        const defaults = service.updateGroupTopology(group);

        expect(constrained.snapshot.degreeLimit).toBe(2);
        for (const nextHops of Object.values(constrained.snapshot.nextHopsBySessionId)) {
            expect(nextHops.length).toBeLessThanOrEqual(2);
        }
        expect(defaults.snapshot.degreeLimit).toBe(5);
    });

    it('keeps default threshold behavior when no per-update topology options are passed', () => {
        const service = new RallarRtcTopologyService({ now: () => 100 });

        expect(service.updateGroupTopology(createRtcTopologyGroupSnapshot('small-room', createRtcTopologyMemberIds(4))).snapshot.topology).toBe(
            'star'
        );
        expect(service.updateGroupTopology(createRtcTopologyGroupSnapshot('tree-room', createRtcTopologyMemberIds(5))).snapshot.topology).toBe(
            'tree'
        );
        expect(service.updateGroupTopology(createRtcTopologyGroupSnapshot('mesh-room', createRtcTopologyMemberIds(16))).snapshot.topology).toBe(
            'mesh'
        );
    });

    it('retains the graph version while advancing an unchanged group revision', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({ now: () => 100 });

        const first = service.updateGroupTopology(group);
        const second = service.updateGroupTopology({
            ...group,
            causalRevision: { ...group.causalRevision, groupRevision: 2 },
            group: { ...group.group, snapshotVersion: 2 }
        });

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        expect(second.snapshot).not.toBe(first.snapshot);
        expect(second.snapshot.version).toBe(first.snapshot.version);
        expect(second.snapshot.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 2,
            presenceRevision: 0
        });
    });

    it('republishes tree topology when RTT measurements change next hops', () => {
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({ now: () => 100 });

        const first = service.updateGroupTopology(group);
        const second = service.updateGroupTopology(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'));

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(true);
        expect(second.snapshot.version).toBe(2);
        expect(second.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
        expect(second.snapshot.nextHopsBySessionId).not.toEqual(first.snapshot.nextHopsBySessionId);
    });

    it('continues versioning from a supplied previous snapshot', () => {
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const firstWorker = new RallarRtcTopologyService({ now: () => 100 });
        const secondWorker = new RallarRtcTopologyService({ now: () => 200 });

        const first = firstWorker.updateGroupTopology(group);
        const second = secondWorker.updateGroupTopology(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'), {
            previous: first.snapshot
        });

        expect(second.changed).toBe(true);
        expect(second.previous).toBe(first.snapshot);
        expect(second.snapshot.version).toBe(2);
        expect(second.snapshot.createdAtEpochMs).toBe(first.snapshot.createdAtEpochMs);
        expect(second.snapshot.updatedAtEpochMs).toBe(200);
    });

    it('reuses the exact previous snapshot when topology semantics are unchanged', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
        const first = planRallarRtcTopologySnapshot({
            group,
            topology: 'tree',
            nextHopsBySessionId: {
                'peer-1': ['peer-2', 'peer-3'],
                'peer-2': ['peer-1'],
                'peer-3': ['peer-1']
            },
            degreeLimit: 5,
            nowEpochMs: 100
        });
        const unchanged = planRallarRtcTopologySnapshot({
            group,
            previous: first.snapshot,
            topology: 'tree',
            nextHopsBySessionId: first.snapshot.nextHopsBySessionId,
            degreeLimit: 5,
            nowEpochMs: 200
        });

        expect(unchanged.snapshot).toBe(first.snapshot);
    });

    it('rebuilds an active one-session plan after its empty-hop tombstone', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1']);
        const active = planRallarRtcTopologySnapshot({
            group,
            topology: 'star',
            nextHopsBySessionId: { 'peer-1': [] },
            degreeLimit: 1,
            nowEpochMs: 100
        });

        const rebuilt = planRallarRtcTopologySnapshot({
            group,
            previous: { ...active.snapshot, state: 'removed' },
            topology: 'star',
            nextHopsBySessionId: { 'peer-1': [] },
            degreeLimit: 1,
            nowEpochMs: 200
        });

        expect(rebuilt.changed).toBe(true);
        expect(rebuilt.snapshot.state).toBe('active');
    });

    it('advances source causality without a topology version bump', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
        const first = planRallarRtcTopologySnapshot({
            group,
            topology: 'tree',
            nextHopsBySessionId: {
                'peer-1': ['peer-2', 'peer-3'],
                'peer-2': ['peer-1'],
                'peer-3': ['peer-1']
            },
            degreeLimit: 5,
            nowEpochMs: 100
        });
        const causallyAdvancedGroup = {
            ...group,
            causalRevision: { ...group.causalRevision, groupRevision: 2 },
            group: { ...group.group, snapshotVersion: 2 }
        };
        const causallyAdvanced = planRallarRtcTopologySnapshot({
            group: causallyAdvancedGroup,
            previous: first.snapshot,
            topology: 'tree',
            nextHopsBySessionId: first.snapshot.nextHopsBySessionId,
            degreeLimit: 5,
            nowEpochMs: 300
        });

        expect(causallyAdvanced.changed).toBe(false);
        expect(causallyAdvanced.snapshot.version).toBe(first.snapshot.version);
        expect(causallyAdvanced.snapshot.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 2,
            presenceRevision: 0
        });
    });

    it('bumps the version and timestamp when next-hop order changes', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
        const first = planRallarRtcTopologySnapshot({
            group,
            topology: 'tree',
            nextHopsBySessionId: {
                'peer-1': ['peer-2', 'peer-3'],
                'peer-2': ['peer-1'],
                'peer-3': ['peer-1']
            },
            degreeLimit: 5,
            nowEpochMs: 100
        });
        const orderedHopChange = planRallarRtcTopologySnapshot({
            group,
            previous: first.snapshot,
            topology: 'tree',
            nextHopsBySessionId: {
                'peer-1': ['peer-3', 'peer-2'],
                'peer-2': ['peer-1'],
                'peer-3': ['peer-1']
            },
            degreeLimit: 5,
            nowEpochMs: 400
        });

        expect(orderedHopChange.changed).toBe(true);
        expect(orderedHopChange.snapshot.version).toBe(first.snapshot.version + 1);
        expect(orderedHopChange.snapshot.updatedAtEpochMs).toBe(400);
    });

    it('copies canonical group scope into the snapshot', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
        const snapshot = planRallarRtcTopologySnapshot({
            group,
            topology: 'tree',
            nextHopsBySessionId: {
                'peer-1': ['peer-2', 'peer-3'],
                'peer-2': ['peer-1'],
                'peer-3': ['peer-1']
            },
            degreeLimit: 5,
            nowEpochMs: 100
        }).snapshot;

        expect(snapshot.groupRef).toEqual({
            applicationId: group.group.applicationId,
            workspaceId: group.group.workspaceId,
            groupId: group.group.groupId
        });
        expect(snapshot.groupRef).not.toBe(group.group);
    });
});

/**
 * Every pair inside consecutive cliques reports, so each member's reporting degree is spent inside its clique and
 * the planner can only connect the room through its no-RTT seed.
 */
function createSaturatedCliqueRttMeasurements(
    memberSessionIds: readonly string[],
    cliqueSize: number
): readonly RttMeasurementInfo[] {
    const measurements: RttMeasurementInfo[] = [];
    for (let start = 0; start < memberSessionIds.length; start += cliqueSize) {
        const clique = memberSessionIds.slice(start, start + cliqueSize);
        for (const [index, from] of clique.entries()) {
            for (const to of clique.slice(index + 1)) {
                const version = measurements.length + 1;
                measurements.push(createRtcTopologyRttMeasurement({ sessionIdFrom: from, sessionIdTo: to, rttMs: 50, version }));
            }
        }
    }
    return measurements;
}

/** One near-uniform report per tree edge: what members of a reporting-degree-limited tree measure. */
function createTreeEdgeRttMeasurements(
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>
): readonly RttMeasurementInfo[] {
    const measurements: RttMeasurementInfo[] = [];
    for (const [from, nextHops] of Object.entries(nextHopsBySessionId).sort(([left], [right]) => left.localeCompare(right))) {
        for (const to of nextHops.filter((neighbour) => from < neighbour)) {
            const version = measurements.length + 1;
            measurements.push(createRtcTopologyRttMeasurement({ sessionIdFrom: from, sessionIdTo: to, rttMs: 50 + (version % 5), version }));
        }
    }
    return measurements;
}
