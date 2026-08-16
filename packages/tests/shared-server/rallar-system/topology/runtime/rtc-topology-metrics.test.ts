import { describe, expect, it } from 'vitest';

import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts';

describe('RtcTopologyMetrics', () => {
  it('records every topology metric category and resets counters without replacing live counts', () => {
    const metrics = new RtcTopologyMetrics();

    metrics.recordTopologyUpdate(1);
    metrics.recordTopologyUpdate(0);
    metrics.recordTopologyResult(true);
    metrics.recordTopologyResult(false);
    metrics.recordStarPlan(-1);
    metrics.recordNoRttTreePlan(2);
    metrics.recordNoRttMeshPlan(3);
    metrics.recordWeightedPlan(4);
    metrics.recordWeightedRoomGraph(5, true);
    metrics.recordIncrementalPlan();
    metrics.recordIncrementalFallback('delta-too-large');
    metrics.recordIncrementalFallback('invariant-violation');
    metrics.recordHysteresisHold();
    metrics.recordRttQueue('new', true);
    metrics.recordRttQueue('coalesced', false);
    metrics.recordRttFlush(false);
    metrics.recordRttFlush(true);
    metrics.recordPublish(true);
    metrics.recordPublish(false);
    metrics.recordFingerprintSkip();
    metrics.recordRemoval(true);
    metrics.recordRemoval(false);

    expect(metrics.read(7, 8)).toMatchObject({
      topologyUpdateCount: 2,
      topologyChangedCount: 1,
      topologyUnchangedCount: 1,
      updatesWithRttMeasurementCount: 1,
      updatesWithoutRttMeasurementCount: 1,
      starPlanCount: 1,
      starPlanDurationMs: 0,
      noRttTreePlanCount: 1,
      noRttTreePlanDurationMs: 2,
      noRttMeshPlanCount: 1,
      noRttMeshPlanDurationMs: 3,
      weightedPlanCount: 1,
      weightedPlanDurationMs: 4,
      weightedRoomGraphBuildCount: 1,
      weightedRoomGraphBuildDurationMs: 5,
      weightedRoomGraphSparseFallbackCount: 1,
      incrementalPlanCount: 1,
      incrementalPlanFallbackFullCount: 2,
      incrementalPlanInvariantFallbackCount: 1,
      hysteresisHeldKindCount: 1,
      rttQueueRequestCount: 2,
      rttQueueNewCount: 1,
      rttQueueCoalescedCount: 1,
      rttQueueImmediateCount: 1,
      rttFlushAttemptCount: 2,
      rttFlushSkippedCount: 1,
      rttFlushExecutedCount: 1,
      topologyPublishAttemptCount: 2,
      topologyPublishedCount: 1,
      topologyPublishSkippedUnchangedCount: 1,
      topologyRebuildSkippedFingerprintCount: 1,
      topologyRemovalRequestCount: 2,
      topologyRemovedCount: 1,
      topologyRemoveMissCount: 1,
      topologySnapshotCount: 7,
      pendingRttUpdateCount: 8,
    });

    metrics.reset();

    expect(metrics.read(7, 8)).toMatchObject({
      topologyUpdateCount: 0,
      weightedPlanCount: 0,
      topologySnapshotCount: 7,
      pendingRttUpdateCount: 8,
    });
  });
});
