export type RallarRtcTopologyMetrics = Readonly<{
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
    topologySnapshotCount: number;
    pendingRttUpdateCount: number;
}>;

export type MutableRallarRtcTopologyMetrics = {
    -readonly [K in keyof Omit<
        RallarRtcTopologyMetrics,
        'pendingRttUpdateCount' | 'topologySnapshotCount'
    >]: number;
};

export const emptyTopologyMetrics = (): MutableRallarRtcTopologyMetrics => ({
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
});
