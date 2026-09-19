import type {
    RallarBlackBoxTestReportFragment,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
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
        events: state.events.length,
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
