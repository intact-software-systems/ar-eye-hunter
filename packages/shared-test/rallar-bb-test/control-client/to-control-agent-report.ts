import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestReportFragment,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import type { RallarBlackBoxEventHistory } from '../runtime/event-history.ts';
import { toRuntimeStats } from '../runtime/to-runtime-stats.ts';

export interface ToControlAgentReportInput {
    readonly runId: string;
    readonly agentId: string;
    readonly reportId: string;
    readonly reason: string;
    readonly state: RallarBlackBoxTestState;
    readonly atEpochMs: number;
}

export interface ControlAgentReportSummary {
    readonly status: RallarBlackBoxTestRuntimeStatus;
    readonly commands: number;
    readonly events: number;
    readonly failures: number;
    /** Absent before the agent completes a command. */
    readonly latestCommandId?: string;
    /** Absent before the agent records an event. */
    readonly latestEventAtEpochMs?: number;
    readonly reason: string;
}

/** A final report carries counts and stats only; results and events already streamed over the control socket. */
export function toControlAgentReport(input: ToControlAgentReportInput): RallarBlackBoxTestReportFragment {
    const { state } = input;
    const summary: ControlAgentReportSummary = {
        status: state.status,
        commands: state.commandHistory.length,
        events: state.eventHistory.totalEvents,
        failures: state.failures.length,
        latestCommandId: state.commandHistory.at(-1)?.commandId,
        latestEventAtEpochMs: state.events.at(-1)?.atEpochMs,
        reason: input.reason
    };
    return redactRallarBlackBoxValue(
        {
            reportId: input.reportId,
            runId: input.runId,
            agentId: input.agentId,
            atEpochMs: input.atEpochMs,
            summary,
            stats: toRuntimeStats(state, input.atEpochMs)
        },
        state.currentConfig?.redaction
    );
}

export interface ControlOwnedReportFacts {
    readonly state: RallarBlackBoxTestState;
    readonly admittedCommandIds: ReadonlySet<string>;
    readonly completedResults: WeakSet<RallarBlackBoxTestResult>;
    readonly publishedEvents: WeakSet<RallarBlackBoxTestEvent>;
    readonly publishedHistory: RallarBlackBoxEventHistory | undefined;
}

/** Project only actually admitted/completed/published facts; cumulative runtime diagnostics remain local. */
export function toControlOwnedReportState(facts: ControlOwnedReportFacts): RallarBlackBoxTestState {
    const { state } = facts;
    const commandHistory = Object.values(state.resultCache).filter((result) => facts.completedResults.has(result));
    const activeCommand = facts.admittedCommandIds.has(state.activeCommand?.commandId ?? '')
        ? state.activeCommand
        : undefined;
    const latest = commandHistory.at(-1);
    const events = state.events.filter((event) => facts.publishedEvents.has(event));
    return {
        ...state,
        status: activeCommand ? 'running' : latest ? (latest.ok ? 'completed' : 'failed') : 'idle',
        activeCommand,
        activeCommandStartedAtEpochMs: activeCommand ? state.activeCommandStartedAtEpochMs : undefined,
        commandHistory,
        failures: commandHistory.filter((result) => !result.ok),
        events,
        eventHistory: toPublishedReportHistory(state.eventHistory, facts.publishedHistory, events.length),
        latestStats: undefined
    };
}

function toPublishedReportHistory(
    runtimeHistory: RallarBlackBoxEventHistory,
    publishedHistory: RallarBlackBoxEventHistory | undefined,
    retainedEvents: number
): RallarBlackBoxEventHistory {
    if (publishedHistory === undefined) {
        return runtimeHistory;
    }
    return {
        ...runtimeHistory,
        totalEvents: publishedHistory.totalEvents,
        countsByKind: publishedHistory.countsByKind,
        reconnects: publishedHistory.reconnects,
        retainedEvents,
        evictedEvents: publishedHistory.totalEvents - retainedEvents
    };
}
