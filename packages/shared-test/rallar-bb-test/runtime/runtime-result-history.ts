import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestStatsSnapshot
} from '../rallar-black-box-test-contracts.ts';
import { toRuntimeLoadResultSummary } from './to-runtime-stats.ts';

export interface RuntimeResultHistory {
    readonly totalCommands: number;
    readonly totalFailures: number;
    readonly releasedResults: number;
    readonly durationSumMs: number;
    readonly minDurationMs: number | undefined;
    readonly maxDurationMs: number | undefined;
    readonly lastDurationMs: number | undefined;
    readonly lastResultOk: boolean | undefined;
    readonly lastCommandId: string | undefined;
    readonly load: RallarBlackBoxTestStatsSnapshot['load'];
}

export function createRuntimeResultHistory(): RuntimeResultHistory {
    return {
        totalCommands: 0,
        totalFailures: 0,
        releasedResults: 0,
        durationSumMs: 0,
        minDurationMs: undefined,
        maxDurationMs: undefined,
        lastDurationMs: undefined,
        lastResultOk: undefined,
        lastCommandId: undefined,
        load: undefined
    };
}

export function computeAppendedResultHistory(
    history: RuntimeResultHistory,
    result: RallarBlackBoxTestResult
): RuntimeResultHistory {
    return {
        totalCommands: history.totalCommands + 1,
        totalFailures: history.totalFailures + (result.ok ? 0 : 1),
        releasedResults: history.releasedResults,
        durationSumMs: history.durationSumMs + result.durationMs,
        minDurationMs: Math.min(history.minDurationMs ?? result.durationMs, result.durationMs),
        maxDurationMs: Math.max(history.maxDurationMs ?? result.durationMs, result.durationMs),
        lastDurationMs: result.durationMs,
        lastResultOk: result.ok,
        lastCommandId: result.commandId,
        load: toRuntimeLoadResultSummary(history.load, result)
    };
}
