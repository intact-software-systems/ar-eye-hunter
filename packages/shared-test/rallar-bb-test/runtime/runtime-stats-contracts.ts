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
 * The page's session ledger report (D180) beside `orderingTracks`, the ordering snapshots its inbound stores state
 * they hold, each store's latest statement since the page's last `close`, summed (D191).
 */
export interface RallarBlackBoxTestAlmUsage extends ALVolatileSessionReport {
    readonly orderingTracks: number;
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
