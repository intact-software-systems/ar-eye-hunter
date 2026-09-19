import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStatsSnapshot
} from './rallar-black-box-test-contracts.ts';

export function getRallarBlackBoxCurrentConfig(
    state: RallarBlackBoxTestState
): RallarBlackBoxTestConfig | undefined {
    return state.currentConfig;
}

export function getRallarBlackBoxActiveCommand(
    state: RallarBlackBoxTestState
): (RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>) | undefined {
    return state.activeCommand;
}

export function getRallarBlackBoxCommandHistory(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestResult[] {
    return state.commandHistory;
}

export function getRallarBlackBoxEvents(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestEvent[] {
    return state.events;
}

export function toRallarBlackBoxMessages(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestEvent[] {
    return state.events.filter((event) => event.kind === 'message');
}

export function toRallarBlackBoxDiagnostics(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestEvent[] {
    return state.events.filter((event) => event.kind === 'diagnostic');
}

export function getRallarBlackBoxFailures(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestResult[] {
    return state.failures;
}

export function getRallarBlackBoxLatestStats(
    state: RallarBlackBoxTestState
): RallarBlackBoxTestStatsSnapshot | undefined {
    return state.latestStats;
}

export function getRallarBlackBoxFirstFailure(
    state: RallarBlackBoxTestState
): RallarBlackBoxTestResult | undefined {
    return state.failures[0];
}
