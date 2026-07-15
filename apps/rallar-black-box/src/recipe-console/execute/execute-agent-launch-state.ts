export type ExecuteAgentLaunchRunIdSync = Readonly<{
    selectedControlRunId: string | undefined;
    runId?: string;
    invalidate: boolean;
}>;

export type ExecuteAgentLaunchCohort = Readonly<{
    runId: string;
    agentIds: readonly string[];
}>;

export function executeAgentLaunchRunIdSync(input: Readonly<{
    previousControlRunId?: string;
    nextControlRunId?: string;
    currentRunId: string;
}>): ExecuteAgentLaunchRunIdSync | undefined {
    if (input.previousControlRunId === input.nextControlRunId) return undefined;
    const runId = input.nextControlRunId?.trim();
    return {
        selectedControlRunId: input.nextControlRunId,
        ...(runId ? { runId } : {}),
        invalidate: Boolean(runId && runId !== input.currentRunId.trim()),
    };
}

export function sameExecuteAgentIds(
    left: readonly string[],
    right: readonly string[],
): boolean {
    if (left.length !== right.length) return false;
    const expected = new Set(left);
    return right.every(agentId => expected.has(agentId));
}

export function readyExecuteAgentIds(
    cohort: ExecuteAgentLaunchCohort | undefined,
    rows: readonly Readonly<{ agentId: string; targetable: boolean }>[],
): readonly string[] {
    if (!cohort) return [];
    const targetable = new Set(
        rows.filter(row => row.targetable).map(row => row.agentId),
    );
    return cohort.agentIds.filter(agentId => targetable.has(agentId));
}

export function mergeExecuteAgentLaunchCohort(
    previous: ExecuteAgentLaunchCohort | undefined,
    runId: string,
    agentIds: readonly string[],
): ExecuteAgentLaunchCohort {
    return {
        runId,
        agentIds: [...new Set([
            ...(previous?.runId === runId ? previous.agentIds : []),
            ...agentIds,
        ])].sort(),
    };
}

export function executeAgentLaunchErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
