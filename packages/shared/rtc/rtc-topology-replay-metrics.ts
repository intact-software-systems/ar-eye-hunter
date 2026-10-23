export const RTC_TOPOLOGY_REPLAY_WAKE_SOURCES = [
    'startup',
    'notification',
    'local-commit',
    'poll'
] as const;
export const RTC_TOPOLOGY_REPLAY_DRAIN_OUTCOMES = [
    'caught-up',
    'yielded',
    'failed',
    'lease-lost'
] as const;
export const RTC_TOPOLOGY_REPLAY_ENTRY_OUTCOMES = [
    'delivered',
    'current-repair',
    'no-local-recipient',
    'send-failed',
    'corrupt'
] as const;
export const RTC_TOPOLOGY_REPLAY_CURSOR_OUTCOMES = [
    'advanced',
    'conflict',
    'gap'
] as const;
export const RTC_TOPOLOGY_REPLAY_HYDRATION_OUTCOMES = [
    'sent',
    'unauthorized',
    'no-topology',
    'retry',
    'stale-generation'
] as const;

export type RtcTopologyReplayWakeSource = typeof RTC_TOPOLOGY_REPLAY_WAKE_SOURCES[number];
export type RtcTopologyReplayDrainOutcome = typeof RTC_TOPOLOGY_REPLAY_DRAIN_OUTCOMES[number];
export type RtcTopologyReplayEntryOutcome = typeof RTC_TOPOLOGY_REPLAY_ENTRY_OUTCOMES[number];
export type RtcTopologyReplayCursorOutcome = typeof RTC_TOPOLOGY_REPLAY_CURSOR_OUTCOMES[number];
export type RtcTopologyReplayHydrationOutcome = typeof RTC_TOPOLOGY_REPLAY_HYDRATION_OUTCOMES[number];

export interface RtcTopologyReplayMetrics {
    readonly wakeCountBySource: Readonly<Record<RtcTopologyReplayWakeSource, number>>;
    readonly drainCountByOutcome: Readonly<Record<RtcTopologyReplayDrainOutcome, number>>;
    readonly entryCountByOutcome: Readonly<Record<RtcTopologyReplayEntryOutcome, number>>;
    readonly cursorCountByOutcome: Readonly<Record<RtcTopologyReplayCursorOutcome, number>>;
    readonly hydrationCountByOutcome: Readonly<Record<RtcTopologyReplayHydrationOutcome, number>>;
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
