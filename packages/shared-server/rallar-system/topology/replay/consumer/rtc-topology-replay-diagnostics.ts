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

export type RtcTopologyReplayDiagnosticsEvent =
    | Readonly<{ kind: 'wake'; source: RtcTopologyReplayWakeSource; }>
    | Readonly<{
        kind: 'drain';
        outcome: RtcTopologyReplayDrainOutcome;
        durationMs: number;
        pageCount: number;
        entryCount: number;
        maxLagEntries: number;
    }>
    | Readonly<{ kind: 'entry'; outcome: RtcTopologyReplayEntryOutcome; }>
    | Readonly<{ kind: 'cursor'; outcome: RtcTopologyReplayCursorOutcome; }>
    | Readonly<{ kind: 'hydration'; outcome: RtcTopologyReplayHydrationOutcome; }>;

export type RtcTopologyReplayDiagnosticsSink = (
    event: RtcTopologyReplayDiagnosticsEvent
) => void;

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

export interface RtcTopologyReplayDiagnostics {
    readonly record: RtcTopologyReplayDiagnosticsSink;
    readMetrics(): RtcTopologyReplayMetrics;
    resetMetrics(): void;
}

export function createRtcTopologyReplayDiagnostics(): RtcTopologyReplayDiagnostics {
    let metrics = emptyMetrics();
    const record: RtcTopologyReplayDiagnosticsSink = (event) => {
        switch (event.kind) {
            case 'wake':
                metrics.wakeCountBySource[event.source] += 1;
                return;
            case 'drain':
                recordDrain(metrics, event);
                return;
            case 'entry':
                recordEntry(metrics, event.outcome);
                return;
            case 'cursor':
                metrics.cursorCountByOutcome[event.outcome] += 1;
                if (event.outcome === 'conflict') {
                    metrics.cursorConflictCount += 1;
                }
                if (event.outcome === 'gap') {
                    metrics.gapCount += 1;
                }
                return;
            case 'hydration':
                metrics.hydrationCountByOutcome[event.outcome] += 1;
                return;
        }
    };
    return {
        record,
        readMetrics: () => cloneMetrics(metrics),
        resetMetrics: () => {
            metrics = emptyMetrics();
        }
    };
}

interface MutableMetrics {
    wakeCountBySource: Record<RtcTopologyReplayWakeSource, number>;
    drainCountByOutcome: Record<RtcTopologyReplayDrainOutcome, number>;
    entryCountByOutcome: Record<RtcTopologyReplayEntryOutcome, number>;
    cursorCountByOutcome: Record<RtcTopologyReplayCursorOutcome, number>;
    hydrationCountByOutcome: Record<RtcTopologyReplayHydrationOutcome, number>;
    drainAttemptCount: number;
    drainCompletionCount: number;
    drainFailureCount: number;
    pageCount: number;
    replayedEntryCount: number;
    directCurrentRepairCount: number;
    noLocalRecipientCount: number;
    sendFailureCount: number;
    cursorConflictCount: number;
    gapCount: number;
    corruptReferenceCount: number;
    totalDrainDurationMs: number;
    maxObservedLagEntries: number;
}

function emptyMetrics(): MutableMetrics {
    return {
        wakeCountBySource: countRecord(RTC_TOPOLOGY_REPLAY_WAKE_SOURCES),
        drainCountByOutcome: countRecord(RTC_TOPOLOGY_REPLAY_DRAIN_OUTCOMES),
        entryCountByOutcome: countRecord(RTC_TOPOLOGY_REPLAY_ENTRY_OUTCOMES),
        cursorCountByOutcome: countRecord(RTC_TOPOLOGY_REPLAY_CURSOR_OUTCOMES),
        hydrationCountByOutcome: countRecord(RTC_TOPOLOGY_REPLAY_HYDRATION_OUTCOMES),
        drainAttemptCount: 0,
        drainCompletionCount: 0,
        drainFailureCount: 0,
        pageCount: 0,
        replayedEntryCount: 0,
        directCurrentRepairCount: 0,
        noLocalRecipientCount: 0,
        sendFailureCount: 0,
        cursorConflictCount: 0,
        gapCount: 0,
        corruptReferenceCount: 0,
        totalDrainDurationMs: 0,
        maxObservedLagEntries: 0
    };
}

function recordDrain(
    metrics: MutableMetrics,
    event: Extract<RtcTopologyReplayDiagnosticsEvent, Readonly<{ kind: 'drain'; }>>
): void {
    requireNonNegativeFinite(event.durationMs, 'drain duration');
    requireNonNegativeSafeInteger(event.pageCount, 'drain page count');
    requireNonNegativeSafeInteger(event.entryCount, 'drain entry count');
    requireNonNegativeSafeInteger(event.maxLagEntries, 'drain maximum lag');
    metrics.drainCountByOutcome[event.outcome] += 1;
    metrics.drainAttemptCount += 1;
    if (event.outcome === 'caught-up' || event.outcome === 'yielded') {
        metrics.drainCompletionCount += 1;
    }
    else {
        metrics.drainFailureCount += 1;
    }
    metrics.pageCount += event.pageCount;
    metrics.replayedEntryCount += event.entryCount;
    metrics.totalDrainDurationMs += event.durationMs;
    metrics.maxObservedLagEntries = Math.max(
        metrics.maxObservedLagEntries,
        event.maxLagEntries
    );
}

function recordEntry(metrics: MutableMetrics, outcome: RtcTopologyReplayEntryOutcome): void {
    metrics.entryCountByOutcome[outcome] += 1;
    if (outcome === 'current-repair') {
        metrics.directCurrentRepairCount += 1;
    }
    if (outcome === 'no-local-recipient') {
        metrics.noLocalRecipientCount += 1;
    }
    if (outcome === 'send-failed') {
        metrics.sendFailureCount += 1;
    }
    if (outcome === 'corrupt') {
        metrics.corruptReferenceCount += 1;
    }
}

function cloneMetrics(metrics: MutableMetrics): RtcTopologyReplayMetrics {
    return {
        ...metrics,
        wakeCountBySource: { ...metrics.wakeCountBySource },
        drainCountByOutcome: { ...metrics.drainCountByOutcome },
        entryCountByOutcome: { ...metrics.entryCountByOutcome },
        cursorCountByOutcome: { ...metrics.cursorCountByOutcome },
        hydrationCountByOutcome: { ...metrics.hydrationCountByOutcome }
    };
}

function countRecord<const T extends readonly string[]>(values: T): Record<T[number], number> {
    return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function requireNonNegativeFinite(value: number, label: string): void {
    if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`RTC topology replay ${label} is invalid`);
    }
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`RTC topology replay ${label} is invalid`);
    }
}
