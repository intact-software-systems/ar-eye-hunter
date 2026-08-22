import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStatsSnapshot
} from './types.ts';

export function selectRallarBlackBoxCurrentConfig(
    state: RallarBlackBoxTestState
): RallarBlackBoxTestConfig | undefined {
    return state.currentConfig;
}

export function selectRallarBlackBoxActiveCommand(
    state: RallarBlackBoxTestState
): (RallarBlackBoxTestCommand & Readonly<{ commandId: string; }>) | undefined {
    return state.activeCommand;
}

export function selectRallarBlackBoxCommandHistory(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestResult[] {
    return state.commandHistory;
}

export function selectRallarBlackBoxEvents(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestEvent[] {
    return state.events;
}

export function selectRallarBlackBoxMessages(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestEvent[] {
    return state.events.filter((event) => event.kind === 'message');
}

export function selectRallarBlackBoxDiagnostics(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestEvent[] {
    return state.events.filter((event) => event.kind === 'diagnostic');
}

export function selectRallarBlackBoxFailures(
    state: RallarBlackBoxTestState
): readonly RallarBlackBoxTestResult[] {
    return state.failures;
}

export function selectRallarBlackBoxLatestStats(
    state: RallarBlackBoxTestState
): RallarBlackBoxTestStatsSnapshot | undefined {
    return state.latestStats;
}

export function selectRallarBlackBoxFirstFailure(
    state: RallarBlackBoxTestState
): RallarBlackBoxTestResult | undefined {
    return state.failures[0];
}
