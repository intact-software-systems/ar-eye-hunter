export type ExecuteAgentLaunchRunIdSync = Readonly<{
    selectedControlRunId: string | undefined;
    runId?: string;
    invalidate: boolean;
}>;

export type ExecuteAgentLaunchCohort = Readonly<{
    runId: string;
    agentIds: readonly string[];
}>;

export type ExecuteAgentPopupNavigationState = Readonly<{
    unavailableAgentIds: readonly string[];
    cohort?: ExecuteAgentLaunchCohort;
    message: string;
}>;

export function executeAgentLaunchRunIdSync(
    input: Readonly<{
        previousControlRunId?: string;
        nextControlRunId?: string;
        currentRunId: string;
    }>
): ExecuteAgentLaunchRunIdSync | undefined {
    if (input.previousControlRunId === input.nextControlRunId) {
        return undefined;
    }
    const runId = input.nextControlRunId?.trim();
    return {
        selectedControlRunId: input.nextControlRunId,
        ...(runId ? { runId } : {}),
        invalidate: Boolean(runId && runId !== input.currentRunId.trim())
    };
}

export function sameExecuteAgentIds(
    left: readonly string[],
    right: readonly string[]
): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const expected = new Set(left);
    return right.every((agentId) => expected.has(agentId));
}

export function readyExecuteAgentIds(
    cohort: ExecuteAgentLaunchCohort | undefined,
    rows: readonly Readonly<{ agentId: string; targetable: boolean; }>[]
): readonly string[] {
    if (!cohort) {
        return [];
    }
    const targetable = new Set(
        rows.filter((row) => row.targetable).map((row) => row.agentId)
    );
    return cohort.agentIds.filter((agentId) => targetable.has(agentId));
}

export function mergeExecuteAgentLaunchCohort(
    previous: ExecuteAgentLaunchCohort | undefined,
    runId: string,
    agentIds: readonly string[]
): ExecuteAgentLaunchCohort {
    return {
        runId,
        agentIds: [
            ...new Set([
                ...(previous?.runId === runId ? previous.agentIds : []),
                ...agentIds
            ])
        ].sort()
    };
}

export function projectExecuteAgentPopupNavigation(
    input: Readonly<{
        runId: string;
        blockedAgentIds: readonly string[];
        closedAgentIds: readonly string[];
        navigatedAgentIds: readonly string[];
    }>
): ExecuteAgentPopupNavigationState {
    const unavailableAgentIds = [
        ...input.blockedAgentIds,
        ...input.closedAgentIds
    ];
    const opened = input.navigatedAgentIds.length;
    const unavailable = unavailableAgentIds.length;
    return {
        unavailableAgentIds,
        cohort: opened > 0
            ? { runId: input.runId, agentIds: input.navigatedAgentIds }
            : undefined,
        message: unavailable > 0
            ? `Opened ${opened} browser agent ${plural(opened, 'tab', 'tabs')}. ${unavailable} ${
                plural(unavailable, 'popup was', 'popups were')
            } blocked or closed. Use the copy-link fallback below.`
            : `Opened ${opened} browser agent ${plural(opened, 'tab', 'tabs')}. Waiting for registration.`
    };
}

export function executeAgentLaunchErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function plural(count: number, one: string, many: string): string {
    return count === 1 ? one : many;
}
