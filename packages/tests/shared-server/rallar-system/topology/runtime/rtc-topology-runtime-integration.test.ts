import { describe, expect, it } from 'vitest';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { RtcTopologyPlanner } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/runtime/rtc-topology-metrics.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

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

    it('debounces RTT-triggered topology rebuilds until the pending update is due', () => {
        let now = 1_000;
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50
        });

        const first = service.updateGroupTopology(group);
        const queued = service.queueRttTopologyUpdate(group);

        expect(queued.newlyQueued).toBe(true);
        expect(queued.immediate).toBe(false);
        expect(queued.delayMs).toBe(50);
        expect(service.flushDueRttTopologyUpdate(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'))).toBeUndefined();

        now = 1_049;
        expect(service.flushDueRttTopologyUpdate(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'))).toBeUndefined();

        now = 1_050;
        const second = service.flushDueRttTopologyUpdate(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'));

        expect(second?.changed).toBe(true);
        expect(second?.snapshot.version).toBe(first.snapshot.version + 1);
        expect(second?.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
    });

    it('coalesces multiple RTT queue requests into one pending deadline', () => {
        let now = 1_000;
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50
        });

        service.updateGroupTopology(group);
        const first = service.queueRttTopologyUpdate(group);
        now = 1_025;
        const second = service.queueRttTopologyUpdate(group);

        expect(second.newlyQueued).toBe(false);
        expect(second.dueAtEpochMs).toBe(first.dueAtEpochMs);
        expect(second.delayMs).toBe(25);
    });

    it('records the RTT queue request before a throwing clock is read', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => {
                throw new Error('clock unavailable');
            }
        });

        expect(() => service.queueRttTopologyUpdate(group)).toThrow('clock unavailable');
        expect(service.readMetrics()).toMatchObject({
            rttQueueRequestCount: 1,
            rttQueueNewCount: 0,
            rttQueueCoalescedCount: 0,
            rttQueueImmediateCount: 0
        });
    });

    it('records the RTT flush attempt before a throwing clock is read', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        let shouldThrow = false;
        const service = new RallarRtcTopologyService({
            now: () => {
                if (shouldThrow) {
                    throw new Error('clock unavailable');
                }
                return 100;
            }
        });

        service.queueRttTopologyUpdate(group);
        service.resetMetrics();
        shouldThrow = true;

        expect(() => service.claimDueRttTopologyUpdate(group.group)).toThrow('clock unavailable');
        expect(service.readMetrics()).toMatchObject({
            rttFlushAttemptCount: 1,
            rttFlushSkippedCount: 0,
            rttFlushExecutedCount: 0
        });
    });

    it.each([
        {
            name: 'plan reads active sessions before scope and retains its attempt',
            metric: 'topologyUpdateCount' as const,
            invoke: (service: RallarRtcTopologyService, group: GroupSnapshot) => service.planGroupTopologyAt(group, [], {}, 100),
            createGroup: createGroupWithThrowingSessionsAndScope,
            expectedError: 'group sessions unavailable',
            expectedClockReads: 0
        },
        {
            name: 'queue retains its request before scope translation fails',
            metric: 'rttQueueRequestCount' as const,
            invoke: (service: RallarRtcTopologyService, group: GroupSnapshot) => service.queueRttTopologyUpdate(group),
            createGroup: createGroupWithThrowingScope,
            expectedError: 'group scope unavailable',
            expectedClockReads: 0
        },
        {
            name: 'claim retains its attempt before scope translation fails',
            metric: 'rttFlushAttemptCount' as const,
            invoke: (service: RallarRtcTopologyService, group: GroupSnapshot) => service.claimDueRttTopologyUpdate(group.group),
            createGroup: createGroupWithThrowingNestedScope,
            expectedError: 'group scope unavailable',
            expectedClockReads: 0
        }
    ])('$name', ({ metric, invoke, createGroup, expectedError, expectedClockReads }) => {
        let clockReads = 0;
        const service = new RallarRtcTopologyService({
            now: () => {
                clockReads += 1;
                throw new Error('clock unavailable');
            }
        });
        const group = createGroup();

        expect(() => invoke(service, group)).toThrowError(new Error(expectedError));

        expect(service.readMetrics()[metric]).toBe(1);
        expect(clockReads).toBe(expectedClockReads);
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
            { topologyKind: 'tree', rttReportingDegreeLimit: 1 },
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
        expect(metrics.read(0, 0)).toMatchObject({
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
            { topologyKind: 'tree', rttReportingDegreeLimit: 1 },
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
        expect(metrics.read(0, 0)).toMatchObject({
            weightedRoomGraphBuildCount: 1,
            weightedRoomGraphSparseFallbackCount: 1,
            weightedRoomGraphBuildDurationMs: 0,
            weightedPlanCount: 0,
            topologyChangedCount: 0,
            topologyUnchangedCount: 0
        });
    });

    it('records topology rebuild, RTT queue, flush, and publish metrics', () => {
        let now = 1_000;
        const memberSessionIds = createRtcTopologyMemberIds(5);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50
        });

        const first = service.updateGroupTopology(group);
        service.recordTopologyPublishResult(first.changed);
        const queued = service.queueRttTopologyUpdate(group);
        now = 1_025;
        const coalesced = service.queueRttTopologyUpdate(group);

        expect(queued.newlyQueued).toBe(true);
        expect(coalesced.newlyQueued).toBe(false);
        expect(service.flushDueRttTopologyUpdate(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'))).toBeUndefined();

        now = 1_050;
        const second = service.flushDueRttTopologyUpdate(group, createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'));
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
            pendingRttUpdateCount: 0
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
            pendingRttUpdateCount: 0
        });
    });

    it('resets metrics without clearing committed snapshots or pending RTT work', () => {
        let now = 1_000;
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50
        });

        service.updateGroupTopology(group);
        now = 1_010;
        service.queueRttTopologyUpdate(group);
        service.resetMetrics();

        expect(service.readMetrics()).toMatchObject({
            topologyUpdateCount: 0,
            rttQueueRequestCount: 0,
            rttFlushAttemptCount: 0,
            topologySnapshotCount: 1,
            pendingRttUpdateCount: 1
        });
    });

    it('clears pending RTT work only after committed snapshot observation succeeds', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => 1_000,
            rttRebuildDebounceMs: 50
        });

        const current = service.updateGroupTopology(group).snapshot;
        service.queueRttTopologyUpdate(group);

        expect(() => service.observeCommittedTopologySnapshot({ ...current, name: 'Conflicting room' })).toThrowError(
            new Error(`RTC topology process-cache revision conflict: ${current.overlayId}`)
        );
        expect(service.readRttTopologyUpdateDelayMs(group)).toBe(50);

        expect(
            service.observeCommittedTopologySnapshot({
                ...current,
                sourceGroupStateCausalRevision: {
                    ...current.sourceGroupStateCausalRevision,
                    groupRevision: current.sourceGroupStateCausalRevision.groupRevision + 1
                }
            })
        ).toBe(true);
        expect(service.readRttTopologyUpdateDelayMs(group)).toBeUndefined();
    });

    it('removes cached topology snapshots and pending RTT work for inactive groups', () => {
        let now = 1_000;
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
        const service = new RallarRtcTopologyService({
            now: () => now,
            rttRebuildDebounceMs: 50
        });

        service.updateGroupTopology(group);
        now = 1_010;
        service.queueRttTopologyUpdate(group);

        expect(service.readSnapshot(group)).toBeDefined();
        expect(service.readMetrics()).toMatchObject({
            topologySnapshotCount: 1,
            pendingRttUpdateCount: 1
        });

        expect(service.removeGroupTopology(group)).toBe(true);

        expect(service.readSnapshot(group)).toBeUndefined();
        expect(service.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 1,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 0,
            topologySnapshotCount: 0,
            pendingRttUpdateCount: 0
        });

        expect(service.removeGroupTopology(group)).toBe(false);
        expect(service.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 2,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 1,
            topologySnapshotCount: 0,
            pendingRttUpdateCount: 0
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

function createGroupWithThrowingScope(): GroupSnapshot {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    Object.defineProperty(group, 'group', {
        get: () => {
            throw new Error('group scope unavailable');
        }
    });
    return group;
}

function createGroupWithThrowingNestedScope(): GroupSnapshot {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    const groupRef = group.group;
    Object.defineProperty(group, 'group', { value: createThrowingGroupRef(groupRef) });
    return group;
}

function createThrowingGroupRef(groupRef: GroupRef): GroupRef {
    return {
        get applicationId(): string {
            throw new Error('group scope unavailable');
        },
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
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
