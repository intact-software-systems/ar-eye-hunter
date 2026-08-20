import type { EvolvePlannedTopologyFullRebuildReason } from '../planning/evolve-planned-topology.ts';

export interface RallarRtcTopologyMetrics {
  readonly topologyUpdateCount: number;
  readonly topologyChangedCount: number;
  readonly topologyUnchangedCount: number;
  readonly updatesWithRttMeasurementCount: number;
  readonly updatesWithoutRttMeasurementCount: number;
  readonly starPlanCount: number;
  readonly starPlanDurationMs: number;
  readonly noRttTreePlanCount: number;
  readonly noRttTreePlanDurationMs: number;
  readonly noRttMeshPlanCount: number;
  readonly noRttMeshPlanDurationMs: number;
  readonly weightedPlanCount: number;
  readonly weightedPlanDurationMs: number;
  readonly weightedRoomGraphBuildCount: number;
  readonly weightedRoomGraphBuildDurationMs: number;
  readonly weightedRoomGraphSparseFallbackCount: number;
  readonly incrementalPlanCount: number;
  readonly incrementalPlanFallbackFullCount: number;
  readonly incrementalPlanInvariantFallbackCount: number;
  readonly hysteresisHeldKindCount: number;
  readonly rttQueueRequestCount: number;
  readonly rttQueueNewCount: number;
  readonly rttQueueCoalescedCount: number;
  readonly rttQueueImmediateCount: number;
  readonly rttFlushAttemptCount: number;
  readonly rttFlushSkippedCount: number;
  readonly rttFlushExecutedCount: number;
  readonly topologyPublishAttemptCount: number;
  readonly topologyPublishedCount: number;
  readonly topologyPublishSkippedUnchangedCount: number;
  readonly topologyRebuildSkippedFingerprintCount: number;
  readonly topologyRemovalRequestCount: number;
  readonly topologyRemovedCount: number;
  readonly topologyRemoveMissCount: number;
  readonly topologySnapshotCount: number;
  readonly pendingRttUpdateCount: number;
}

interface RtcTopologyMetricsState {
  topologyUpdateCount: number;
  topologyChangedCount: number;
  topologyUnchangedCount: number;
  updatesWithRttMeasurementCount: number;
  updatesWithoutRttMeasurementCount: number;
  starPlanCount: number;
  starPlanDurationMs: number;
  noRttTreePlanCount: number;
  noRttTreePlanDurationMs: number;
  noRttMeshPlanCount: number;
  noRttMeshPlanDurationMs: number;
  weightedPlanCount: number;
  weightedPlanDurationMs: number;
  weightedRoomGraphBuildCount: number;
  weightedRoomGraphBuildDurationMs: number;
  weightedRoomGraphSparseFallbackCount: number;
  incrementalPlanCount: number;
  incrementalPlanFallbackFullCount: number;
  incrementalPlanInvariantFallbackCount: number;
  hysteresisHeldKindCount: number;
  rttQueueRequestCount: number;
  rttQueueNewCount: number;
  rttQueueCoalescedCount: number;
  rttQueueImmediateCount: number;
  rttFlushAttemptCount: number;
  rttFlushSkippedCount: number;
  rttFlushExecutedCount: number;
  topologyPublishAttemptCount: number;
  topologyPublishedCount: number;
  topologyPublishSkippedUnchangedCount: number;
  topologyRebuildSkippedFingerprintCount: number;
  topologyRemovalRequestCount: number;
  topologyRemovedCount: number;
  topologyRemoveMissCount: number;
}

export class RtcTopologyMetrics {
  private state: RtcTopologyMetricsState = createRtcTopologyMetricsState();

  recordTopologyUpdate(rttMeasurementCount: number): void {
    this.recordTopologyUpdateAttempt();
    this.recordTopologyRttMeasurementCount(rttMeasurementCount);
  }

  recordTopologyUpdateAttempt(): void {
    this.state.topologyUpdateCount += 1;
  }

  recordTopologyRttMeasurementCount(rttMeasurementCount: number): void {
    if (rttMeasurementCount > 0) {
      this.state.updatesWithRttMeasurementCount += 1;
      return;
    }
    this.state.updatesWithoutRttMeasurementCount += 1;
  }

  recordTopologyResult(changed: boolean): void {
    if (changed) {
      this.state.topologyChangedCount += 1;
      return;
    }
    this.state.topologyUnchangedCount += 1;
  }

  recordStarPlan(durationMs: number): void {
    this.state.starPlanCount += 1;
    this.state.starPlanDurationMs += nonNegativeDurationMs(durationMs);
  }

  recordNoRttTreePlan(durationMs: number): void {
    this.state.noRttTreePlanCount += 1;
    this.state.noRttTreePlanDurationMs += nonNegativeDurationMs(durationMs);
  }

  recordNoRttMeshPlan(durationMs: number): void {
    this.state.noRttMeshPlanCount += 1;
    this.state.noRttMeshPlanDurationMs += nonNegativeDurationMs(durationMs);
  }

  recordWeightedPlan(durationMs: number): void {
    this.recordWeightedPlanAttempt();
    this.recordWeightedPlanDuration(durationMs);
  }

  recordWeightedPlanAttempt(): void {
    this.state.weightedPlanCount += 1;
  }

  recordWeightedPlanDuration(durationMs: number): void {
    this.state.weightedPlanDurationMs += nonNegativeDurationMs(durationMs);
  }

  recordWeightedRoomGraphAttempt(): void {
    this.state.weightedRoomGraphBuildCount += 1;
  }

  recordWeightedRoomGraphSparseFallback(): void {
    this.state.weightedRoomGraphSparseFallbackCount += 1;
  }

  recordWeightedRoomGraphDuration(durationMs: number): void {
    this.state.weightedRoomGraphBuildDurationMs += nonNegativeDurationMs(durationMs);
  }

  recordIncrementalPlan(): void {
    this.state.incrementalPlanCount += 1;
  }

  recordIncrementalFallback(reason: EvolvePlannedTopologyFullRebuildReason): void {
    this.state.incrementalPlanFallbackFullCount += 1;
    if (reason === 'invariant-violation') {
      this.state.incrementalPlanInvariantFallbackCount += 1;
    }
  }

  recordHysteresisHold(): void {
    this.state.hysteresisHeldKindCount += 1;
  }

  recordRttQueue(result: 'new' | 'coalesced', immediate: boolean): void {
    this.recordRttQueueRequest();
    this.recordRttQueueResult(result, immediate);
  }

  recordRttQueueRequest(): void {
    this.state.rttQueueRequestCount += 1;
  }

  recordRttQueueResult(result: 'new' | 'coalesced', immediate: boolean): void {
    if (result === 'new') {
      this.state.rttQueueNewCount += 1;
    } else {
      this.state.rttQueueCoalescedCount += 1;
    }
    if (immediate) {
      this.state.rttQueueImmediateCount += 1;
    }
  }

  recordRttFlush(executed: boolean): void {
    this.recordRttFlushAttempt();
    this.recordRttFlushResult(executed);
  }

  recordRttFlushAttempt(): void {
    this.state.rttFlushAttemptCount += 1;
  }

  recordRttFlushResult(executed: boolean): void {
    if (executed) {
      this.state.rttFlushExecutedCount += 1;
      return;
    }
    this.state.rttFlushSkippedCount += 1;
  }

  recordPublish(changed: boolean): void {
    this.state.topologyPublishAttemptCount += 1;
    if (changed) {
      this.state.topologyPublishedCount += 1;
      return;
    }
    this.state.topologyPublishSkippedUnchangedCount += 1;
  }

  recordFingerprintSkip(): void {
    this.state.topologyRebuildSkippedFingerprintCount += 1;
  }

  recordRemoval(removed: boolean): void {
    this.state.topologyRemovalRequestCount += 1;
    if (removed) {
      this.state.topologyRemovedCount += 1;
      return;
    }
    this.state.topologyRemoveMissCount += 1;
  }

  read(snapshotCount: number, pendingRttUpdateCount: number): RallarRtcTopologyMetrics {
    return {
      ...this.state,
      topologySnapshotCount: snapshotCount,
      pendingRttUpdateCount,
    };
  }

  reset(): void {
    this.state = createRtcTopologyMetricsState();
  }
}

function createRtcTopologyMetricsState(): RtcTopologyMetricsState {
  return {
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
  };
}

function nonNegativeDurationMs(durationMs: number): number {
  return Math.max(0, durationMs);
}
