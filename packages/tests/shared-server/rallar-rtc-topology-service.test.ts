import { describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
// prettier-ignore
import {
    computeCanonicalTopologyPairWeight,
} from '@shared-server/rallar-system/topology/planning/canonical-topology-planning-input.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';

describe('RallarRtcTopologyService', () => {
    it('creates scoped star topology for groups below tree size', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(4));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const result = service.updateGroupTopology(group);

        expect(result.changed).toBe(true);
        expect(result.snapshot.overlayId).toBe(toScopedOverlayId(group.group));
        expect(result.snapshot.topology).toBe('star');
        expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual([
            'peer-2',
            'peer-3',
            'peer-4',
        ]);
    });

    it('does not build a weighted room graph for star topology', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(8));
        const service = new RallarRtcTopologyService({
            now: () => 100,
            treeMinSize: 9,
            meshMinSize: 10,
        });
        const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

        const result = service.updateGroupTopology(group);

        expect(createRoomGraph).not.toHaveBeenCalled();
        expect(result.snapshot.topology).toBe('star');
        expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual([
            'peer-2',
            'peer-3',
            'peer-4',
            'peer-5',
            'peer-6',
            'peer-7',
            'peer-8',
        ]);
    });

    it('uses fallback graph weights until RTT measurements are available', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(3));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const fallbackGraph = service.createRoomGraph(group);
        const fallbackEdge = fallbackGraph.edge('peer-1', 'peer-3');
        expect(fallbackEdge).toBeDefined();
        expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBe(
            computeCanonicalTopologyPairWeight('peer-1', 'peer-3'),
        );
        expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight'))
            .toBeGreaterThanOrEqual(1);
        expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight'))
            .toBeLessThan(32);

        const rttGraph = service.createRoomGraph(group, [
            {
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-3',
                rttMs: 42,
                createdAtEpochMs: 1,
                version: 1,
            },
        ]);
        const rttEdge = rttGraph.edge('peer-1', 'peer-3');
        expect(rttEdge).toBeDefined();
        expect(rttGraph.getEdgeAttribute(rttEdge!, 'weight')).toBe(42);
    });

    it('uses the latest RTT measurement for duplicate reverse pairs', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(3));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const graph = service.createRoomGraph(group, [
            {
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-3',
                rttMs: 42,
                createdAtEpochMs: 1,
                version: 1,
            },
            {
                sessionIdFrom: 'peer-3',
                sessionIdTo: 'peer-1',
                rttMs: 7,
                createdAtEpochMs: 2,
                version: 2,
            },
        ]);
        const edge = graph.edge('peer-1', 'peer-3');

        expect(edge).toBeDefined();
        expect(graph.getEdgeAttribute(edge!, 'weight')).toBe(7);
    });

    it('preserves delimiter-colliding and Unicode-lookalike RTT graph edges', () => {
        const composed = '\u00e9';
        const decomposed = 'e\u0301';
        const sessionIds = ['a', 'a::b', 'b::c', 'c', composed, decomposed];
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: sessionIds.length,
            rttReportingDegreeLimit: sessionIds.length,
        });
        const graph = service.createRoomGraph(createGroupSnapshot('room-pairs', sessionIds), [
            rtt('a', 'b::c', 11, 1),
            rtt('a::b', 'c', 22, 1),
            rtt(composed, 'a', 33, 1),
            rtt(decomposed, 'a', 44, 1),
            rtt('b::c', 'a', 55, 2),
        ]);

        expect(edgeWeight(graph, 'a', 'b::c')).toBe(55);
        expect(edgeWeight(graph, 'a::b', 'c')).toBe(22);
        expect(edgeWeight(graph, composed, 'a')).toBe(33);
        expect(edgeWeight(graph, decomposed, 'a')).toBe(44);
    });

    it('orders equal-weight Unicode RTT edges by exact code units', () => {
        const decomposed = 'e\u0301';
        const composed = '\u00e9';
        const group = createGroupSnapshot('room-1', [
            composed,
            decomposed,
            'z',
        ]);
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: 3,
            rttReportingDegreeLimit: 3,
        });

        const graph = service.createRoomGraph(group, [
            {
                sessionIdFrom: decomposed,
                sessionIdTo: composed,
                rttMs: 5,
                createdAtEpochMs: 1,
                version: 1,
            },
            {
                sessionIdFrom: decomposed,
                sessionIdTo: 'z',
                rttMs: 5,
                createdAtEpochMs: 2,
                version: 2,
            },
            {
                sessionIdFrom: 'z',
                sessionIdTo: composed,
                rttMs: 5,
                createdAtEpochMs: 3,
                version: 3,
            },
        ]);

        expect(graph.edges().map((edge) => graph.extremities(edge))).toEqual([
            [decomposed, 'z'],
            [decomposed, composed],
            ['z', composed],
        ]);
    });

    it('documents complete weighted room graph materialization with partial RTT input', () => {
        const memberSessionIds = createMemberIds(8);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => 100,
            rttReportingDegreeLimit: 8,
        });

        const graph = service.createRoomGraph(group, [
            {
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-2',
                rttMs: 5,
                createdAtEpochMs: 1,
                version: 1,
            },
        ]);

        expect(graph.order).toBe(8);
        expect(graph.size).toBe((8 * 7) / 2);
        expect(graph.hasEdge('peer-1', 'peer-8')).toBe(true);
    });

    it('builds a sparse weighted candidate graph when RTT reporting is degree bounded', () => {
        const memberSessionIds = createMemberIds(32);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
        });

        const measurements = createCentralRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) =>
                rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1'
            )
            .slice(0, 5);

        const graph = service.createRoomGraph(group, measurements);

        expect(graph.order).toBe(32);
        expect(graph.size).toBeLessThanOrEqual((32 * 5) / 2);
    });

    it('keeps RTT-weighted candidate graph edge count linear in room size', () => {
        const memberSessionIds = createMemberIds(200);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
        });
        const measurements = createCentralRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) =>
                rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1'
            )
            .slice(0, 5);

        const graph = service.createRoomGraph(group, measurements);

        expect(graph.order).toBe(200);
        expect(graph.size).toBeLessThanOrEqual((200 * 5) / 2);
    });

    it('keeps sparse RTT topology output degree-limited', () => {
        const memberSessionIds = createMemberIds(32);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
        });
        const measurements = createCentralRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) =>
                rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1'
            )
            .slice(0, 5);

        const result = service.updateGroupTopology(group, measurements);

        for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
            expect(nextHops.length).toBeLessThanOrEqual(5);
        }
    });

    it('does not build a weighted room graph for no-RTT mesh topology', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(16));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });
        const graphPathService = new RallarRtcTopologyService({
            now: () => 100,
        });
        const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

        const result = service.updateGroupTopology(group);
        const graphPathResult = graphPathService.updateGroupTopology(group, [
            {
                sessionIdFrom: 'outside-a',
                sessionIdTo: 'outside-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1,
            },
        ]);

        expect(createRoomGraph).not.toHaveBeenCalled();
        expect(result.snapshot.topology).toBe('mesh');
        expect(result.snapshot.nextHopsBySessionId).toEqual(
            graphPathResult.snapshot.nextHopsBySessionId,
        );
        const validation = validateGroupTopologyNextHops({
            activeSessionIds: new Set(result.snapshot.activeSessionIds),
            nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
            maxDegree: result.snapshot.degreeLimit,
        });
        expect(validation.issues).toEqual([]);
    });

    it('uses the weighted room graph for mesh topology with RTT measurements', () => {
        const memberSessionIds = createMemberIds(16);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const rttMeasurements = createCentralRttMeasurements(
            memberSessionIds,
            'peer-1',
        );
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });
        const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

        const result = service.updateGroupTopology(group, rttMeasurements);

        expect(createRoomGraph).toHaveBeenCalledWith(group, rttMeasurements);
        expect(result.snapshot.topology).toBe('mesh');
    });

    it.each([
        [5, 2],
        [8, 3],
        [10, 5],
        [15, 4],
    ] as const)(
        'does not build a weighted room graph for no-RTT %s-member tree topology with degree %s',
        (memberCount, degreeLimit) => {
            const group = createGroupSnapshot('room-1', createMemberIds(memberCount));
            const service = new RallarRtcTopologyService({
                now: () => 100,
                degreeLimit,
                meshMinSize: 999,
            });
            const graphPathService = new RallarRtcTopologyService({
                now: () => 100,
                degreeLimit,
                meshMinSize: 999,
            });
            const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

            const result = service.updateGroupTopology(group);
            const graphPathResult = graphPathService.updateGroupTopology(group, [
                {
                    sessionIdFrom: 'outside-a',
                    sessionIdTo: 'outside-b',
                    rttMs: 1,
                    createdAtEpochMs: 1,
                    version: 1,
                },
            ]);

            expect(createRoomGraph).not.toHaveBeenCalled();
            expect(result.snapshot.topology).toBe('tree');
            expect(result.snapshot.nextHopsBySessionId).toEqual(
                graphPathResult.snapshot.nextHopsBySessionId,
            );
        },
    );

    it.each([
        [5, 'tree'],
        [15, 'tree'],
        [16, 'mesh'],
    ] as const)(
        'creates degree-limited %s-member %s topology',
        (memberCount, topology) => {
            const group = createGroupSnapshot('room-1', createMemberIds(memberCount));
            const service = new RallarRtcTopologyService({
                now: () => 100,
            });

            const result = service.updateGroupTopology(group);

            expect(result.changed).toBe(true);
            expect(result.snapshot.topology).toBe(topology);

            for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
                expect(nextHops.length).toBeLessThanOrEqual(5);
            }
        },
    );

    it('honors request topology kind override for star topology', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(8));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const result = service.updateGroupTopology(group, [], {
            topologyOptions: {
                topologyKind: 'star',
            },
        });

        expect(result.snapshot.topology).toBe('star');
        expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual([
            'peer-2',
            'peer-3',
            'peer-4',
            'peer-5',
            'peer-6',
            'peer-7',
            'peer-8',
        ]);
    });

    it('honors request topology kind override for tree topology', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(4));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const result = service.updateGroupTopology(group, [], {
            topologyOptions: {
                topologyKind: 'tree',
            },
        });

        expect(result.snapshot.topology).toBe('tree');
        for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
            expect(nextHops.length).toBeLessThanOrEqual(5);
        }
    });

    it('honors request topology kind override for mesh topology when group size can support mesh', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(16));
        const service = new RallarRtcTopologyService({
            now: () => 100,
            meshMinSize: 999,
        });

        const result = service.updateGroupTopology(group, [], {
            topologyOptions: {
                topologyKind: 'mesh',
            },
        });

        expect(result.snapshot.topology).toBe('mesh');
        const validation = validateGroupTopologyNextHops({
            activeSessionIds: new Set(result.snapshot.activeSessionIds),
            nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
            maxDegree: result.snapshot.degreeLimit,
        });
        expect(validation.issues).toEqual([]);
    });

    it('uses per-update degree limit without replacing service-wide defaults', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(8));
        const service = new RallarRtcTopologyService({
            now: () => 100,
            degreeLimit: 5,
            meshMinSize: 999,
        });

        const constrained = service.updateGroupTopology(group, [], {
            topologyOptions: {
                degreeLimit: 2,
            },
        });
        const defaults = service.updateGroupTopology(group);

        expect(constrained.snapshot.degreeLimit).toBe(2);
        for (const nextHops of Object.values(constrained.snapshot.nextHopsBySessionId)) {
            expect(nextHops.length).toBeLessThanOrEqual(2);
        }
        expect(defaults.snapshot.degreeLimit).toBe(5);
    });

    it('keeps default threshold behavior when no per-update topology options are passed', () => {
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        expect(service.updateGroupTopology(
            createGroupSnapshot('small-room', createMemberIds(4)),
        ).snapshot.topology).toBe('star');
        expect(service.updateGroupTopology(
            createGroupSnapshot('tree-room', createMemberIds(5)),
        ).snapshot.topology).toBe('tree');
        expect(service.updateGroupTopology(
            createGroupSnapshot('mesh-room', createMemberIds(16)),
        ).snapshot.topology).toBe('mesh');
    });

    it('retains the graph version while advancing an unchanged group revision', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const first = service.updateGroupTopology(group);
        const second = service.updateGroupTopology({
            ...group,
            stateRevision: 2,
            causalRevision: {
                ...group.causalRevision,
                groupRevision: 2,
            },
            group: {
                ...group.group,
                snapshotVersion: 2,
            },
        });

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(false);
        expect(second.snapshot).not.toBe(first.snapshot);
        expect(second.snapshot.version).toBe(first.snapshot.version);
        expect(second.snapshot.sourceGroupStateCausalRevision).toEqual({
            groupRevision: 2,
            presenceRevision: 0,
        });
    });

    it('republishes tree topology when RTT measurements change next hops', () => {
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => 100,
        });

        const first = service.updateGroupTopology(group);
        const second = service.updateGroupTopology(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
        );

        expect(first.changed).toBe(true);
        expect(second.changed).toBe(true);
        expect(second.snapshot.version).toBe(2);
        expect(second.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
        expect(second.snapshot.nextHopsBySessionId).not.toEqual(
            first.snapshot.nextHopsBySessionId,
        );
    });

    it('continues versioning from a supplied previous snapshot', () => {
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const firstWorker = new RallarRtcTopologyService({
            now: () => 100,
        });
        const secondWorker = new RallarRtcTopologyService({
            now: () => 200,
        });

        const first = firstWorker.updateGroupTopology(group);
        const second = secondWorker.updateGroupTopology(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            {
                previous: first.snapshot,
            },
        );

        expect(second.changed).toBe(true);
        expect(second.previous).toBe(first.snapshot);
        expect(second.snapshot.version).toBe(2);
        expect(second.snapshot.createdAtEpochMs).toBe(
            first.snapshot.createdAtEpochMs,
        );
        expect(second.snapshot.updatedAtEpochMs).toBe(200);
    });

    it('hydrates fresh service memory from an unchanged supplied snapshot', () => {
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const firstWorker = new RallarRtcTopologyService({
            now: () => 100,
        });
        const secondWorker = new RallarRtcTopologyService({
            now: () => 200,
        });

        const first = firstWorker.updateGroupTopology(group);
        const second = secondWorker.updateGroupTopology(group, [], {
            previous: first.snapshot,
        });

        expect(second.changed).toBe(false);
        expect(second.snapshot).toBe(first.snapshot);
        expect(secondWorker.readSnapshot(group)).toBe(first.snapshot);
    });

    it('debounces RTT-triggered topology rebuilds until the pending update is due', () => {
        let now = 1_000;
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50,
        });

        const first = service.updateGroupTopology(group);
        const queued = service.queueRttTopologyUpdate(group);

        expect(queued.newlyQueued).toBe(true);
        expect(queued.immediate).toBe(false);
        expect(queued.delayMs).toBe(50);
        expect(
            service.flushDueRttTopologyUpdate(
                group,
                createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            ),
        ).toBeUndefined();

        now = 1_049;
        expect(
            service.flushDueRttTopologyUpdate(
                group,
                createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            ),
        ).toBeUndefined();

        now = 1_050;
        const second = service.flushDueRttTopologyUpdate(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
        );

        expect(second?.changed).toBe(true);
        expect(second?.snapshot.version).toBe(first.snapshot.version + 1);
        expect(second?.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
    });

    it('coalesces multiple RTT queue requests into one pending deadline', () => {
        let now = 1_000;
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50,
        });

        service.updateGroupTopology(group);
        const first = service.queueRttTopologyUpdate(group);
        now = 1_025;
        const second = service.queueRttTopologyUpdate(group);

        expect(second.newlyQueued).toBe(false);
        expect(second.dueAtEpochMs).toBe(first.dueAtEpochMs);
        expect(second.delayMs).toBe(25);
    });

    it('records topology rebuild, RTT queue, flush, and publish metrics', () => {
        let now = 1_000;
        const memberSessionIds = createMemberIds(5);
        const group = createGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50,
        });

        const first = service.updateGroupTopology(group);
        service.recordTopologyPublishResult(first.changed);
        const queued = service.queueRttTopologyUpdate(group);
        now = 1_025;
        const coalesced = service.queueRttTopologyUpdate(group);

        expect(queued.newlyQueued).toBe(true);
        expect(coalesced.newlyQueued).toBe(false);
        expect(
            service.flushDueRttTopologyUpdate(
                group,
                createCentralRttMeasurements(memberSessionIds, 'peer-1'),
            ),
        ).toBeUndefined();

        now = 1_050;
        const second = service.flushDueRttTopologyUpdate(
            group,
            createCentralRttMeasurements(memberSessionIds, 'peer-1'),
        );
        expect(second?.changed).toBe(true);
        service.recordTopologyPublishResult(second?.changed ?? false);

        const metrics = service.readMetrics();
        expect(metrics).toMatchObject({
            topologyUpdateCount: 2,
            topologyChangedCount: 2,
            topologyUnchangedCount: 0,
            updatesWithRttMeasurementCount: 1,
            updatesWithoutRttMeasurementCount: 1,
            noRttTreePlanCount: 1,
            weightedPlanCount: 1,
            weightedRoomGraphBuildCount: 1,
            rttQueueRequestCount: 2,
            rttQueueNewCount: 1,
            rttQueueCoalescedCount: 1,
            rttQueueImmediateCount: 0,
            rttFlushAttemptCount: 2,
            rttFlushSkippedCount: 1,
            rttFlushExecutedCount: 1,
            topologyPublishAttemptCount: 2,
            topologyPublishedCount: 2,
            topologyPublishSkippedUnchangedCount: 0,
            topologySnapshotCount: 1,
            pendingRttUpdateCount: 0,
        });
        expect(metrics.noRttTreePlanDurationMs).toBeGreaterThanOrEqual(0);
        expect(metrics.weightedPlanDurationMs).toBeGreaterThanOrEqual(0);
        expect(metrics.weightedRoomGraphBuildDurationMs).toBeGreaterThanOrEqual(0);

        service.resetMetrics();
        expect(service.readMetrics()).toMatchObject({
            topologyUpdateCount: 0,
            weightedRoomGraphBuildCount: 0,
            topologyPublishAttemptCount: 0,
            topologySnapshotCount: 1,
            pendingRttUpdateCount: 0,
        });
    });

    it('removes cached topology snapshots and pending RTT work for inactive groups', () => {
        let now = 1_000;
        const group = createGroupSnapshot('room-1', createMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50,
        });

        service.updateGroupTopology(group);
        now = 1_010;
        service.queueRttTopologyUpdate(group);

        expect(service.readSnapshot(group)).toBeDefined();
        expect(service.readMetrics()).toMatchObject({
            topologySnapshotCount: 1,
            pendingRttUpdateCount: 1,
        });

        expect(service.removeGroupTopology(group)).toBe(true);

        expect(service.readSnapshot(group)).toBeUndefined();
        expect(service.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 1,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 0,
            topologySnapshotCount: 0,
            pendingRttUpdateCount: 0,
        });

        expect(service.removeGroupTopology(group)).toBe(false);
        expect(service.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 2,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 1,
            topologySnapshotCount: 0,
            pendingRttUpdateCount: 0,
        });
    });
});

function createMemberIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `peer-${index + 1}`);
}

function rtt(
    sessionIdFrom: string,
    sessionIdTo: string,
    rttMs: number,
    version: number,
): RttMeasurementInfo {
    return {
        sessionIdFrom,
        sessionIdTo,
        rttMs,
        createdAtEpochMs: version,
        version,
    };
}

function edgeWeight(
    graph: ReturnType<RallarRtcTopologyService['createRoomGraph']>,
    from: string,
    to: string,
): number | undefined {
    const edge = graph.edge(from, to);
    return edge === undefined ? undefined : graph.getEdgeAttribute(edge, 'weight');
}

function createCentralRttMeasurements(
    memberSessionIds: readonly string[],
    centralSessionId: string,
): readonly RttMeasurementInfo[] {
    const measurements: RttMeasurementInfo[] = [];
    let version = 1;

    for (let i = 0; i < memberSessionIds.length; i++) {
        for (let j = i + 1; j < memberSessionIds.length; j++) {
            const from = memberSessionIds[i];
            const to = memberSessionIds[j];
            measurements.push({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: from === centralSessionId || to === centralSessionId
                    ? 1
                    : 100,
                createdAtEpochMs: version,
                version: version++,
            });
        }
    }

    return measurements;
}

function createGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const ownerPrincipalId = memberSessionIds[0];
    if (!ownerPrincipalId) {
        throw new Error('Expected at least one member session fixture');
    }

    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: {
            applicationId,
            workspaceId,
            groupId,
            slug: null,
            displayName: groupId,
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            created: audit(1),
            updated: audit(1),
        },
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(1),
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `${sessionId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
