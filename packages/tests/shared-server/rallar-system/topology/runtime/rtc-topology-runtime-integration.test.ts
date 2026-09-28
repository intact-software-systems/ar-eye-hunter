import { describe, expect, it } from 'vitest';

import { RtcTopologyPlanner } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createCentralRtcTopologyRttMeasurements, createRtcTopologyGroupSnapshot, createRtcTopologyMemberIds } from '../rtc-topology-test-fixtures.ts';

describe('RTC topology process runtime integration', () => {
    it('hydrates fresh service memory from an unchanged supplied snapshot', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const firstWorker = new RallarRtcTopologyService({ now: () => 100 });
        const secondWorker = new RallarRtcTopologyService({ now: () => 200 });

        const first = firstWorker.updateGroupTopology(group);
        const second = secondWorker.updateGroupTopology(group, [], { previous: first.snapshot });

        expect(second.changed).toBe(false);
        expect(second.snapshot).toBe(first.snapshot);
        expect(secondWorker.readSnapshot(group)).toBe(first.snapshot);
    });

    it('retains the plan attempt when active sessions are read before scope', () => {
        let clockReads = 0;
        const service = new RallarRtcTopologyService({
            now: () => {
                clockReads += 1;
                throw new Error('clock unavailable');
            }
        });
        const group = createGroupWithThrowingSessionsAndScope();

        expect(() => service.planGroupTopologyAt(group, [], {}, 100)).toThrowError(
            new Error('group sessions unavailable')
        );

        expect(service.readMetrics().topologyUpdateCount).toBe(1);
        expect(clockReads).toBe(0);
    });

    it('does not record a weighted graph attempt when topology selection throws first', () => {
        const group = createGroupWithThrowingActiveSessionRead(1);
        const service = new RallarRtcTopologyService({ now: () => 100 });

        expect(() => service.createRoomGraph(group)).toThrow('group sessions unavailable');
        expect(service.readMetrics()).toMatchObject({
            weightedRoomGraphBuildCount: 0,
            weightedRoomGraphBuildDurationMs: 0
        });
    });

    it('records a weighted graph attempt before its next group preparation read throws', () => {
        const group = createGroupWithThrowingActiveSessionRead(2);
        const service = new RallarRtcTopologyService({ now: () => 100 });

        expect(() => service.createRoomGraph(group)).toThrow('group sessions unavailable');
        expect(service.readMetrics()).toMatchObject({
            weightedRoomGraphBuildCount: 1,
            weightedRoomGraphBuildDurationMs: 0
        });
    });

    it('records a graph attempt but no duration when weighted graph preparation throws', () => {
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createGroupWithThrowingActiveSessionRead(3);
        const service = new RallarRtcTopologyService({ now: () => 100 });

        expect(() => planWeightedTopology(service, group, memberSessionIds)).toThrow('group sessions unavailable');
        expect(service.readMetrics()).toMatchObject({
            topologyUpdateCount: 1,
            updatesWithRttMeasurementCount: 1,
            weightedRoomGraphBuildCount: 1,
            weightedRoomGraphBuildDurationMs: 0,
            weightedPlanCount: 0,
            weightedPlanDurationMs: 0
        });
    });

    it('records weighted duration when snapshot display-name access throws', () => {
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        Object.defineProperty(group.group, 'displayName', {
            get: () => {
                throw new Error('group display name unavailable');
            }
        });
        const service = new RallarRtcTopologyService({ now: () => 100 });

        expect(() => planWeightedTopology(service, group, memberSessionIds)).toThrow('group display name unavailable');
        expect(service.readMetrics()).toMatchObject({
            weightedPlanCount: 1,
            topologyChangedCount: 0,
            topologyUnchangedCount: 0
        });
        expect(service.readMetrics().weightedPlanDurationMs).toBeGreaterThan(0);
    });

    it('records sparse fallback timing before fallback graph materialization throws', () => {
        const group = createGroupWithThrowingSecondGraphScopeRead();
        const metrics = new RtcTopologyMetrics();
        const times = [10, 17];
        const planner = new RtcTopologyPlanner(
            // Reporting resolves no lower than the planning degree limit, so the
            // sparse setup pins both limits to 1.
            { topologyKind: 'tree', degreeLimit: 1, rttReportingDegreeLimit: 1 },
            { metrics, durationNowMs: () => times.shift() ?? 17 }
        );

        expect(() =>
            planner.plan({
                group,
                rttMeasurements: createSparseRtcTopologyRttMeasurements(),
                previous: undefined,
                updateOptions: {},
                nowEpochMs: 100
            })
        ).toThrowError(new Error('fallback graph scope unavailable'));
        expect(metrics.read(0)).toMatchObject({
            weightedRoomGraphBuildCount: 1,
            weightedRoomGraphSparseFallbackCount: 1,
            weightedRoomGraphBuildDurationMs: 7,
            weightedPlanCount: 0,
            topologyChangedCount: 0,
            topologyUnchangedCount: 0
        });
    });

    it('records sparse fallback before the duration clock throws', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(3));
        const metrics = new RtcTopologyMetrics();
        let clockReads = 0;
        const planner = new RtcTopologyPlanner(
            // Reporting resolves no lower than the planning degree limit, so the
            // sparse setup pins both limits to 1.
            { topologyKind: 'tree', degreeLimit: 1, rttReportingDegreeLimit: 1 },
            {
                metrics,
                durationNowMs: () => {
                    clockReads += 1;
                    if (clockReads === 2) {
                        throw new Error('duration unavailable');
                    }
                    return 10;
                }
            }
        );

        expect(() =>
            planner.plan({
                group,
                rttMeasurements: createSparseRtcTopologyRttMeasurements(),
                previous: undefined,
                updateOptions: {},
                nowEpochMs: 100
            })
        ).toThrowError(new Error('duration unavailable'));
        expect(metrics.read(0)).toMatchObject({
            weightedRoomGraphBuildCount: 1,
            weightedRoomGraphSparseFallbackCount: 1,
            weightedRoomGraphBuildDurationMs: 0,
            weightedPlanCount: 0,
            topologyChangedCount: 0,
            topologyUnchangedCount: 0
        });
    });

    it('records topology rebuild and publish metrics', () => {
        let now = 1_000;
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({ now: () => now });

        const first = service.updateGroupTopology(group);
        service.recordTopologyPublishResult(first.changed);

        now = 1_050;
        const second = service.updateGroupTopology(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'));
        expect(second.changed).toBe(true);
        expect(second.snapshot.version).toBe(first.snapshot.version + 1);
        service.recordTopologyPublishResult(second.changed);

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
            topologyPublishAttemptCount: 2,
            topologyPublishedCount: 2,
            topologyPublishSkippedUnchangedCount: 0,
            topologySnapshotCount: 1
        });
        expect(metrics.noRttTreePlanDurationMs).toBeGreaterThanOrEqual(0);
        expect(metrics.weightedPlanDurationMs).toBeGreaterThanOrEqual(0);
        expect(metrics.weightedRoomGraphBuildDurationMs).toBeGreaterThanOrEqual(0);

        service.resetMetrics();
        expect(service.readMetrics()).toMatchObject({
            topologyUpdateCount: 0,
            weightedRoomGraphBuildCount: 0,
            topologyPublishAttemptCount: 0,
            topologySnapshotCount: 1
        });
    });

    it('removes cached topology snapshots for inactive groups', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({ now: () => 1_000 });

        service.updateGroupTopology(group);

        expect(service.readSnapshot(group)).toBeDefined();
        expect(service.readMetrics().topologySnapshotCount).toBe(1);

        expect(service.removeGroupTopology(group)).toBe(true);

        expect(service.readSnapshot(group)).toBeUndefined();
        expect(service.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 1,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 0,
            topologySnapshotCount: 0
        });

        expect(service.removeGroupTopology(group)).toBe(false);
        expect(service.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 2,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 1,
            topologySnapshotCount: 0
        });
    });
});

function createGroupWithThrowingActiveSessionRead(throwOnRead: number): GroupSnapshot {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    const activeSessions = group.activeSessions;
    let readCount = 0;
    Object.defineProperty(group, 'activeSessions', {
        get: () => {
            readCount += 1;
            if (readCount === throwOnRead) {
                throw new Error('group sessions unavailable');
            }
            return activeSessions;
        }
    });
    return group;
}

function createGroupWithThrowingSessionsAndScope(): GroupSnapshot {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    Object.defineProperty(group, 'activeSessions', {
        get: () => {
            throw new Error('group sessions unavailable');
        }
    });
    Object.defineProperty(group, 'group', {
        get: () => {
            throw new Error('group scope unavailable');
        }
    });
    return group;
}

function createGroupWithThrowingSecondGraphScopeRead(): GroupSnapshot {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(3));
    const applicationId = group.group.applicationId;
    let applicationIdReads = 0;
    Object.defineProperty(group.group, 'applicationId', {
        get: () => {
            applicationIdReads += 1;
            if (applicationIdReads === 2) {
                throw new Error('fallback graph scope unavailable');
            }
            return applicationId;
        }
    });
    return group;
}

function createSparseRtcTopologyRttMeasurements() {
    return [
        {
            sessionIdFrom: 'peer-1',
            sessionIdTo: 'peer-2',
            rttMs: 5,
            createdAtEpochMs: 1,
            version: 1
        }
    ];
}

function planWeightedTopology(service: RallarRtcTopologyService, group: GroupSnapshot, memberSessionIds: readonly string[]): void {
    service.planGroupTopologyAt(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'), {}, 100);
}
