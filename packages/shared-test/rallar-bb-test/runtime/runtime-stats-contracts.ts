import type { ALCongestionCounters } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALVolatileSessionReport } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type {
    RallarBlackBoxTestLoopPacingSummary,
    RallarBlackBoxTestLoopSendSummary,
    RallarBlackBoxTestLoopThresholdFailure,
    RallarBlackBoxTestRtcStreamResultValue,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestTransport
} from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxEventHistory } from './event-history.ts';

/**
 * The page's session ledger report (D180) beside `orderingTracks` and `deliveredMarkers`, the ordering snapshots
 * and the delivered markers its inbound stores state they hold, each store's latest statement since the page's last
 * `close`, summed.
 */
export interface RallarBlackBoxTestAlmUsage extends ALVolatileSessionReport {
    readonly orderingTracks: number;
    readonly deliveredMarkers: number;
}

export interface RallarBlackBoxIndexedDbStoreCensus {
    readonly name: string;
    readonly rows: number;
}

export interface RallarBlackBoxIndexedDbDatabaseCensus {
    readonly name: string;
    readonly version: number;
    readonly stores: readonly RallarBlackBoxIndexedDbStoreCensus[];
}

export interface RallarBlackBoxIndexedDbCensus {
    readonly databases: readonly RallarBlackBoxIndexedDbDatabaseCensus[];
    /** Databases the page listed but could not count: deleted since the listing, or failing to open or count. */
    readonly uncounted: readonly string[];
}

/** Chromium's `performance.memory`, quantized unless the browser runs with `--enable-precise-memory-info`. */
export interface RallarBlackBoxPageHeap {
    readonly usedJSHeapSize: number;
    readonly totalJSHeapSize: number;
    readonly jsHeapSizeLimit: number;
}

/**
 * The page's storage and heap. Two readings can be absent: `indexedDb` where the page has no IndexedDB or no
 * `indexedDB.databases()` to list it, and `pageHeap` outside Chromium, the one runtime with `performance.memory`.
 * Chromium without `--enable-precise-memory-info` still answers, but in coarse buckets no heap slope can be read from.
 */
export interface RallarBlackBoxBrowserCensus {
    /** Every database of the page's origin, which the headless worker gives each agent a browser context of its own for. */
    readonly indexedDb?: RallarBlackBoxIndexedDbCensus;
    readonly pageHeap?: RallarBlackBoxPageHeap;
}

export interface RallarBlackBoxTestStatsSnapshot {
    readonly resultRetention: { readonly retainedResults: number; readonly releasedResults: number; };
    readonly eventHistory: RallarBlackBoxEventHistory;
    readonly atEpochMs: number;
    readonly runId?: string;
    readonly agentId?: string;
    readonly status: RallarBlackBoxTestRuntimeStatus;
    readonly counters: Readonly<{
        commands: number;
        events: number;
        failures: number;
        messages: number;
        diagnostics: number;
        reconnects?: number;
    }>;
    readonly lastCommandId?: string;
    readonly lastEventAtEpochMs?: number;
    readonly commandLatency?: Readonly<{
        count: number;
        minMs?: number;
        maxMs?: number;
        averageMs?: number;
        lastMs?: number;
    }>;
    readonly rallar?: Readonly<{
        connected?: boolean;
        actor?: string;
        sessionId?: string;
        roomId?: string;
        transport?: RallarBlackBoxTestTransport;
        peerCount?: number;
        laneHealth?: ApiJsonValue;
        /**
         * The page's session ledger, read by the `stats` command through `rallar.messages.readUsage()` (D180), and
         * its ordering snapshots. Absent before the page connects, on a runtime that drives no Rallar page, and in
         * the control client's periodic stats and final report, which read no page.
         */
        alm?: RallarBlackBoxTestAlmUsage;
        /**
         * The congestion decisions the page counted since its last `close`, read by the `stats` command (D186).
         * Absent exactly where `alm` is.
         */
        congestion?: ALCongestionCounters;
    }>;
    /**
     * The page's census, present only in the stats the control client sends every `browserCensusIntervalMs` while the
     * census is on; absent from every other stats, from the `stats` command's result and from the final report.
     */
    readonly browser?: RallarBlackBoxBrowserCensus;
    readonly load?: Readonly<{
        loopCount: number;
        latestLoopCommandId?: string;
        latestPacing?: Omit<RallarBlackBoxTestLoopPacingSummary, 'iterations'>;
        latestSends?: Omit<RallarBlackBoxTestLoopSendSummary, 'observations'>;
        thresholdFailures?: readonly RallarBlackBoxTestLoopThresholdFailure[];
        streamCount?: number;
        latestStreamCommandId?: string;
        latestStream?: Omit<RallarBlackBoxTestRtcStreamResultValue, 'observations'>;
    }>;
}
