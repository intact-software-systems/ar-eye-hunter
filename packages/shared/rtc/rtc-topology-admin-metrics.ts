/** The RTC topology counters the admin operations report: the planning counters, with the replay consumer's under `replay`. */
export interface RtcTopologyAdminMetrics {
    readonly topologyUpdateCount: number;
    readonly topologyWorkComputeDurationMs: number;
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
    readonly topologyPublishAttemptCount: number;
    readonly topologyPublishedCount: number;
    readonly topologyPublishSkippedUnchangedCount: number;
    readonly topologyRebuildSkippedFingerprintCount: number;
    readonly topologyPlanFrozenCount: number;
    readonly topologyRemovalRequestCount: number;
    readonly topologyRemovedCount: number;
    readonly topologyRemoveMissCount: number;
    readonly topologySnapshotCount: number;
    readonly replay: RtcTopologyAdminReplayMetrics;
}

export interface RtcTopologyAdminReplayMetrics {
    readonly wakeCountBySource: Readonly<Record<'startup' | 'notification' | 'local-commit' | 'poll', number>>;
    readonly drainCountByOutcome: Readonly<Record<'caught-up' | 'yielded' | 'failed' | 'lease-lost', number>>;
    readonly entryCountByOutcome: Readonly<
        Record<'delivered' | 'current-repair' | 'no-local-recipient' | 'send-failed' | 'corrupt', number>
    >;
    readonly cursorCountByOutcome: Readonly<Record<'advanced' | 'conflict' | 'gap', number>>;
    readonly hydrationCountByOutcome: Readonly<
        Record<'sent' | 'unauthorized' | 'no-topology' | 'retry' | 'stale-generation', number>
    >;
    readonly drainAttemptCount: number;
    readonly drainCompletionCount: number;
    readonly drainFailureCount: number;
    readonly pageCount: number;
    readonly replayedEntryCount: number;
    readonly directCurrentRepairCount: number;
    readonly noLocalRecipientCount: number;
    readonly sendFailureCount: number;
    readonly cursorConflictCount: number;
    readonly gapCount: number;
    readonly corruptReferenceCount: number;
    readonly totalDrainDurationMs: number;
    readonly maxObservedLagEntries: number;
}
