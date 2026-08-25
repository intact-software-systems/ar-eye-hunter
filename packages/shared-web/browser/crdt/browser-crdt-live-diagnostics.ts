import type {
    RallarCrdtLiveSendOutcome,
    RallarCrdtTransportKind
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type { RallarCrdtApplyResult, RallarCrdtMetricsSink, RallarCrdtSyncResult } from '@shared/crdt/mod.ts';

export namespace BrowserCrdtLiveDiagnostics {
    export type Options = Readonly<{
        documentKey: string;
        metrics?: RallarCrdtMetricsSink;
        now: () => number;
    }>;

    export type Health = Readonly<{
        lastServerAppendSequence?: number;
        lastServerAckAtEpochMs?: number;
        lastSyncError?: string;
        lastLiveTransport?: RallarCrdtTransportKind;
        lastLiveSendStatus?: string;
        liveSentUpdateCount: number;
        liveReceivedUpdateCount: number;
        liveDuplicateUpdateCount: number;
        liveRejectedUpdateCount: number;
        liveDependencyBlockedUpdateCount: number;
        liveRetriedUpdateCount: number;
        liveSyncRequestCount: number;
        liveSyncResponseCount: number;
    }>;
}

/** Owns live-sync counters, errors, and metrics exposed by document health. */
export class BrowserCrdtLiveDiagnostics {
    private readonly options: BrowserCrdtLiveDiagnostics.Options;
    private lastServerAppendSequence: number | undefined;
    private lastServerAckAtEpochMs: number | undefined;
    private lastSyncError: string | undefined;
    private lastLiveTransport: RallarCrdtTransportKind | undefined;
    private lastLiveSendStatus: string | undefined;
    private liveSentUpdateCount = 0;
    private liveReceivedUpdateCount = 0;
    private liveDuplicateUpdateCount = 0;
    private liveRejectedUpdateCount = 0;
    private liveDependencyBlockedUpdateCount = 0;
    private liveRetriedUpdateCount = 0;
    private liveSyncRequestCount = 0;
    private liveSyncResponseCount = 0;

    public constructor(options: BrowserCrdtLiveDiagnostics.Options) {
        this.options = options;
    }

    public health(): BrowserCrdtLiveDiagnostics.Health {
        return {
            lastServerAppendSequence: this.lastServerAppendSequence,
            lastServerAckAtEpochMs: this.lastServerAckAtEpochMs,
            lastSyncError: this.lastSyncError,
            lastLiveTransport: this.lastLiveTransport,
            lastLiveSendStatus: this.lastLiveSendStatus,
            liveSentUpdateCount: this.liveSentUpdateCount,
            liveReceivedUpdateCount: this.liveReceivedUpdateCount,
            liveDuplicateUpdateCount: this.liveDuplicateUpdateCount,
            liveRejectedUpdateCount: this.liveRejectedUpdateCount,
            liveDependencyBlockedUpdateCount: this.liveDependencyBlockedUpdateCount,
            liveRetriedUpdateCount: this.liveRetriedUpdateCount,
            liveSyncRequestCount: this.liveSyncRequestCount,
            liveSyncResponseCount: this.liveSyncResponseCount
        };
    }

    public recordMetric(
        name: Parameters<RallarCrdtMetricsSink['record']>[0]['name'],
        value: number,
        tags?: Readonly<Record<string, string>>
    ): void {
        void this.options.metrics?.record({
            name,
            value,
            atEpochMs: this.options.now(),
            documentKey: this.options.documentKey,
            tags
        });
    }

    public recordSync(result: RallarCrdtSyncResult): void {
        this.recordMetric('crdt.sync.bytes', byteLengthOfJson(result), {
            status: result.status
        });
        this.recordMetric(
            'crdt.dependency.blocked.count',
            result.dependencyBlockedUpdateCount
        );
    }

    public rememberSendOutcome(outcome: RallarCrdtLiveSendOutcome): void {
        this.liveSentUpdateCount += outcome.sentCount;
        const lastResult = outcome.results[outcome.results.length - 1];
        if (lastResult) {
            this.lastLiveTransport = lastResult.transport;
            this.lastLiveSendStatus = lastResult.status;
        }
    }

    public rememberApplyResult(
        result: RallarCrdtApplyResult,
        transport: RallarCrdtTransportKind | undefined
    ): void {
        this.lastLiveTransport = transport ?? this.lastLiveTransport;
        switch (result.status) {
            case 'applied':
                this.liveReceivedUpdateCount += 1;
                break;
            case 'duplicate':
                this.liveDuplicateUpdateCount += 1;
                break;
            case 'dependency-blocked':
                this.liveDependencyBlockedUpdateCount += 1;
                break;
            case 'rejected':
                this.liveRejectedUpdateCount += 1;
                break;
        }
    }

    public setSyncError(message: string | undefined): void {
        this.lastSyncError = message;
    }

    public rememberRetry(): void {
        this.liveRetriedUpdateCount += 1;
    }

    public rememberSyncRequest(): void {
        this.liveSyncRequestCount += 1;
    }

    public rememberSyncResponse(): void {
        this.liveSyncResponseCount += 1;
    }

    public rememberServerAcknowledgement(acceptedAtEpochMs: number): void {
        this.lastServerAckAtEpochMs = acceptedAtEpochMs;
    }

    public rememberServerAppendSequence(sequence: number): void {
        this.lastServerAppendSequence = Math.max(
            this.lastServerAppendSequence ?? 0,
            sequence
        );
    }
}

function byteLengthOfJson(value: RallarCrdtSyncResult): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
