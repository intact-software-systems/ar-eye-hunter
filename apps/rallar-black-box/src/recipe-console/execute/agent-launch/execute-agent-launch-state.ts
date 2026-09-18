export type ExecuteAgentLaunchRunIdSync = Readonly<{
    selectedControlRunId: string | undefined;
    /** Absent when the newly selected control run carries no id for the launch form to adopt. */
    runId?: string;
    invalidate: boolean;
}>;

export type ExecuteAgentLaunchCohort = Readonly<{
    runId: string;
    agentIds: readonly string[];
}>;

export type ExecuteAgentPopupNavigationState = Readonly<{
    unavailableAgentIds: readonly string[];
    /** Absent when no popup was navigated, so this launch produced no cohort. */
    cohort?: ExecuteAgentLaunchCohort;
    message: string;
}>;

export function computeExecuteAgentLaunchRunIdSync(
    input: Readonly<{
        /** Absent while no control run was selected before this change. */
        previousControlRunId?: string;
        /** Absent while no control run is selected after this change. */
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

export function isSameExecuteAgentIds(
    left: readonly string[],
    right: readonly string[]
): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const expected = new Set(left);
    return right.every((agentId) => expected.has(agentId));
}

export function resolveReadyExecuteAgentIds(
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

export function computeMergedExecuteAgentLaunchCohort(
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

export function computeExecuteAgentPopupNavigationState(
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
            ? `Opened ${opened} browser agent ${toPluralWord(opened, 'tab', 'tabs')}. ${unavailable} ${
                toPluralWord(unavailable, 'popup was', 'popups were')
            } blocked or closed. Use the copy-link fallback below.`
            : `Opened ${opened} browser agent ${toPluralWord(opened, 'tab', 'tabs')}. Waiting for registration.`
    };
}

export function decodeExecuteAgentLaunchErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toPluralWord(count: number, one: string, many: string): string {
    return count === 1 ? one : many;
}
