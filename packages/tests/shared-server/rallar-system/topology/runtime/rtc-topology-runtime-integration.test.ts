import { describe, expect, it } from 'vitest';

// prettier-ignore
import {
  RallarRtcTopologyService,
} from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

import {
  createCentralRtcTopologyRttMeasurements,
  createRtcTopologyGroupSnapshot,
  createRtcTopologyMemberIds,
} from '../rtc-topology-test-fixtures.ts';

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
        createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
      ),
    ).toBeUndefined();

    now = 1_049;
    expect(
      service.flushDueRttTopologyUpdate(
        group,
        createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
      ),
    ).toBeUndefined();

    now = 1_050;
    const second = service.flushDueRttTopologyUpdate(
      group,
      createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
    );

    expect(second?.changed).toBe(true);
    expect(second?.snapshot.version).toBe(first.snapshot.version + 1);
    expect(second?.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
  });

  it('coalesces multiple RTT queue requests into one pending deadline', () => {
    let now = 1_000;
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
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

  it('records the RTT queue request before a throwing clock is read', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    const service = new RallarRtcTopologyService({
      now: () => {
        throw new Error('clock unavailable');
      },
    });

    expect(() => service.queueRttTopologyUpdate(group)).toThrow('clock unavailable');
    expect(service.readMetrics()).toMatchObject({
      rttQueueRequestCount: 1,
      rttQueueNewCount: 0,
      rttQueueCoalescedCount: 0,
      rttQueueImmediateCount: 0,
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
      },
    });

    service.queueRttTopologyUpdate(group);
    service.resetMetrics();
    shouldThrow = true;

    expect(() => service.claimDueRttTopologyUpdate(group.group)).toThrow('clock unavailable');
    expect(service.readMetrics()).toMatchObject({
      rttFlushAttemptCount: 1,
      rttFlushSkippedCount: 0,
      rttFlushExecutedCount: 0,
    });
  });

  it('records a weighted graph attempt before a throwing group dependency', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    const activeSessions = group.activeSessions;
    let activeSessionReadCount = 0;
    Object.defineProperty(group, 'activeSessions', {
      get: () => {
        activeSessionReadCount += 1;
        if (activeSessionReadCount === 2) {
          throw new Error('group sessions unavailable');
        }
        return activeSessions;
      },
    });
    const service = new RallarRtcTopologyService({ now: () => 100 });

    expect(() => service.createRoomGraph(group)).toThrow('group sessions unavailable');
    expect(service.readMetrics()).toMatchObject({
      weightedRoomGraphBuildCount: 1,
      weightedRoomGraphBuildDurationMs: 0,
    });
  });

  it('does not record weighted-plan duration or result when later group access throws', () => {
    const memberSessionIds = createRtcTopologyMemberIds(5);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const activeSessions = group.activeSessions;
    let activeSessionReadCount = 0;
    Object.defineProperty(group, 'activeSessions', {
      get: () => {
        activeSessionReadCount += 1;
        if (activeSessionReadCount === 4) {
          throw new Error('group sessions unavailable');
        }
        return activeSessions;
      },
    });
    const service = new RallarRtcTopologyService({ now: () => 100 });

    expect(() =>
      service.planGroupTopologyAt(
        group,
        createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
        {},
        100,
      ),
    ).toThrow('group sessions unavailable');
    expect(service.readMetrics()).toMatchObject({
      weightedPlanCount: 1,
      weightedPlanDurationMs: 0,
      topologyChangedCount: 0,
      topologyUnchangedCount: 0,
    });
  });

  it('records a weighted plan attempt before a throwing group dependency', () => {
    const memberSessionIds = createRtcTopologyMemberIds(5);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const activeSessions = group.activeSessions;
    let activeSessionReadCount = 0;
    Object.defineProperty(group, 'activeSessions', {
      get: () => {
        activeSessionReadCount += 1;
        if (activeSessionReadCount === 4) {
          throw new Error('group sessions unavailable');
        }
        return activeSessions;
      },
    });
    const service = new RallarRtcTopologyService({ now: () => 100 });

    expect(() =>
      service.planGroupTopologyAt(
        group,
        createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
        {},
        100,
      ),
    ).toThrow('group sessions unavailable');
    expect(service.readMetrics()).toMatchObject({
      topologyUpdateCount: 1,
      updatesWithRttMeasurementCount: 1,
      weightedRoomGraphBuildCount: 1,
      weightedPlanCount: 1,
      weightedPlanDurationMs: 0,
    });
    expect(service.readMetrics().weightedRoomGraphBuildDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('records topology rebuild, RTT queue, flush, and publish metrics', () => {
    let now = 1_000;
    const memberSessionIds = createRtcTopologyMemberIds(5);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
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
        createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
      ),
    ).toBeUndefined();

    now = 1_050;
    const second = service.flushDueRttTopologyUpdate(
      group,
      createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
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
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
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
