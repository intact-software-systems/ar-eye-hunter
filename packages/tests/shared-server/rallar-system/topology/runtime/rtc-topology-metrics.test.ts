import { describe, expect, it } from 'vitest';

// prettier-ignore
import {
  RtcTopologyMetrics,
} from '@shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts';

describe('RtcTopologyMetrics', () => {
  it('records every metric category and resets recorded values', () => {
    const metrics = new RtcTopologyMetrics();

    metrics.recordTopologyUpdate(1);
    metrics.recordTopologyUpdate(0);
    metrics.recordTopologyUpdateAttempt();
    metrics.recordTopologyRttMeasurementCount(1);
    metrics.recordTopologyResult(true);
    metrics.recordTopologyResult(false);
    metrics.recordStarPlan(-1);
    metrics.recordNoRttTreePlan(2);
    metrics.recordNoRttMeshPlan(3);
    metrics.recordWeightedPlan(4);
    metrics.recordWeightedPlanAttempt();
    metrics.recordWeightedPlanDuration(4);
    metrics.recordWeightedRoomGraph(5, true);
    metrics.recordWeightedRoomGraphAttempt();
    metrics.recordWeightedRoomGraphDuration(5, true);
    metrics.recordIncrementalPlan();
    metrics.recordIncrementalFallback('delta-too-large');
    metrics.recordIncrementalFallback('invariant-violation');
    metrics.recordHysteresisHold();
    metrics.recordRttQueue('new', true);
    metrics.recordRttQueue('coalesced', false);
    metrics.recordRttQueueRequest();
    metrics.recordRttQueueResult('new', false);
    metrics.recordRttFlush(false);
    metrics.recordRttFlush(true);
    metrics.recordRttFlushAttempt();
    metrics.recordRttFlushResult(true);
    metrics.recordPublish(true);
    metrics.recordPublish(false);
    metrics.recordFingerprintSkip();
    metrics.recordRemoval(true);
    metrics.recordRemoval(false);

    expect(metrics.read(7, 8)).toMatchObject({
      topologyUpdateCount: 3,
      topologyChangedCount: 1,
      topologyUnchangedCount: 1,
      updatesWithRttMeasurementCount: 2,
      updatesWithoutRttMeasurementCount: 1,
      starPlanCount: 1,
      starPlanDurationMs: 0,
      noRttTreePlanCount: 1,
      noRttTreePlanDurationMs: 2,
      noRttMeshPlanCount: 1,
      noRttMeshPlanDurationMs: 3,
      weightedPlanCount: 2,
      weightedPlanDurationMs: 8,
      weightedRoomGraphBuildCount: 2,
      weightedRoomGraphBuildDurationMs: 10,
      weightedRoomGraphSparseFallbackCount: 2,
      incrementalPlanCount: 1,
      incrementalPlanFallbackFullCount: 2,
      incrementalPlanInvariantFallbackCount: 1,
      hysteresisHeldKindCount: 1,
      rttQueueRequestCount: 3,
      rttQueueNewCount: 2,
      rttQueueCoalescedCount: 1,
      rttQueueImmediateCount: 1,
      rttFlushAttemptCount: 3,
      rttFlushSkippedCount: 1,
      rttFlushExecutedCount: 2,
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

    expect(metrics.read(7, 8)).toEqual({
      topologyUpdateCount: 0,
      topologyChangedCount: 0,
      topologyUnchangedCount: 0,
      updatesWithRttMeasurementCount: 0,
      updatesWithoutRttMeasurementCount: 0,
      starPlanCount: 0,
      starPlanDurationMs: 0,
      noRttTreePlanCount: 0,
      noRttTreePlanDurationMs: 0,
      noRttMeshPlanCount: 0,
      noRttMeshPlanDurationMs: 0,
      weightedPlanCount: 0,
      weightedPlanDurationMs: 0,
      weightedRoomGraphBuildCount: 0,
      weightedRoomGraphBuildDurationMs: 0,
      weightedRoomGraphSparseFallbackCount: 0,
      incrementalPlanCount: 0,
      incrementalPlanFallbackFullCount: 0,
      incrementalPlanInvariantFallbackCount: 0,
      hysteresisHeldKindCount: 0,
      rttQueueRequestCount: 0,
      rttQueueNewCount: 0,
      rttQueueCoalescedCount: 0,
      rttQueueImmediateCount: 0,
      rttFlushAttemptCount: 0,
      rttFlushSkippedCount: 0,
      rttFlushExecutedCount: 0,
      topologyPublishAttemptCount: 0,
      topologyPublishedCount: 0,
      topologyPublishSkippedUnchangedCount: 0,
      topologyRebuildSkippedFingerprintCount: 0,
      topologyRemovalRequestCount: 0,
      topologyRemovedCount: 0,
      topologyRemoveMissCount: 0,
      topologySnapshotCount: 7,
      pendingRttUpdateCount: 8,
    });
  });
});
