import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';

export interface RtcTopologyReplayEntryHandlingResult {
    readonly status: 'delivered' | 'current-repair' | 'no-local-recipient' | 'send-failed' | 'gap';
}

export interface RtcTopologyReplayEntryHandler {
    handle(
        entry: RtcTopologyDeliveryLogEntry,
        databaseNowEpochMs: number,
        signal: AbortSignal
    ): Promise<RtcTopologyReplayEntryHandlingResult>;
}

export interface RtcTopologyReplayPort {
    initializeConsumer(
        input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]>;
    discoverPublishers(
        input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]>;
    capturePage(input: RtcTopologyReplayPageInput): Promise<RtcTopologyReplayPageResult>;
    compareAndSetCursor(
        input: RtcTopologyReplayCursorCasInput
    ): Promise<RtcTopologyReplayCursorCasResult>;
}

export interface RtcTopologyReplayServicePolicy {
    readonly antiEntropyIntervalMs: number;
    readonly pageSize: number;
    readonly maxPagesPerTurn: number;
    readonly maxEntriesPerTurn: number;
}

export interface RtcTopologyReplayCursorSnapshot {
    readonly consumerStreamId: string;
    readonly publisherStreamId: string;
    readonly headSequence: number;
    readonly retainedFromSequence: number;
    readonly lastProcessedSequence: number;
    readonly cursorUpdatedAtEpochMs: number;
    readonly publisherLeaseExpiresAtEpochMs: number;
}

export interface RtcTopologyReplayConsumerInput {
    readonly consumerStreamId: string;
}

export interface RtcTopologyReplayPageInput extends RtcTopologyReplayConsumerInput {
    readonly publisherStreamId: string;
    readonly pageSize: number;
}

interface RtcTopologyReplayCapture {
    readonly capturedHeadSequence: number;
    readonly retainedFromSequence: number;
    readonly databaseNowEpochMs: number;
}

export type RtcTopologyReplayPageResult =
    | (
        & RtcTopologyReplayCapture
        & Readonly<{
            status: 'caught-up';
            cursorSequence: number;
        }>
    )
    | (
        & RtcTopologyReplayCapture
        & Readonly<{
            status: 'gap';
            cursorSequence: number;
        }>
    )
    | (
        & RtcTopologyReplayCapture
        & Readonly<{
            status: 'page';
            expectedCursorSequence: number;
            entries: readonly RtcTopologyDeliveryLogEntry[];
            hasMore: boolean;
        }>
    );

export interface RtcTopologyReplayCursorCasInput extends RtcTopologyReplayConsumerInput {
    readonly publisherStreamId: string;
    readonly expectedSequence: number;
    readonly nextSequence: number;
}

export type RtcTopologyReplayCursorCasResult =
    | Readonly<{ status: 'advanced'; }>
    | Readonly<{ status: 'conflict'; currentSequence: number; }>
    | Readonly<{ status: 'missing'; }>;

export interface RtcTopologyReplayCursorRetirementInput {
    readonly retentionMs: number;
    readonly pageSize: number;
}

export interface RtcTopologyReplayCursorRetirementResult {
    readonly deletedCursorCount: number;
}

export interface RtcTopologyReplayStreamRetirementInput {
    readonly pageSize: number;
}

export interface RtcTopologyReplayStreamRetirementResult {
    readonly deletedStreamCount: number;
}
