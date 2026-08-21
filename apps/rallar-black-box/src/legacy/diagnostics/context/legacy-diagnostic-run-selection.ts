export function resolveRunManagerRefreshSelection({
    preferredRunId,
    diagnosticControlRunId,
    controlRunId,
    bootstrapRunId,
    availableRunIds
}: Readonly<{
    preferredRunId: string;
    diagnosticControlRunId?: string;
    controlRunId?: string;
    bootstrapRunId?: string;
    availableRunIds: readonly string[];
}>): Readonly<{ runId: string; issue?: string; }> {
    const available = new Set(availableRunIds);
    if (
        diagnosticControlRunId &&
        (
            preferredRunId === diagnosticControlRunId ||
            preferredRunId === ''
        )
    ) {
        return available.has(diagnosticControlRunId)
            ? { runId: diagnosticControlRunId }
            : {
                runId: '',
                issue: 'Requested diagnostic control run is unavailable. No substitute was selected.'
            };
    }
    const runId = [
        preferredRunId,
        controlRunId,
        bootstrapRunId,
        availableRunIds[0]
    ].find((candidate) => candidate && available.has(candidate)) ?? '';
    return { runId };
}

export function deriveDistributedDiagnosticSelection({
    requestedControlRunId,
    requestedDistributedRunId,
    availableControlRunIds,
    distributedRuns
}: Readonly<{
    requestedControlRunId?: string;
    requestedDistributedRunId?: string;
    availableControlRunIds: readonly string[];
    distributedRuns: readonly Readonly<{
        controlRunId: string;
        distributedRunId: string;
    }>[];
}>): Readonly<{
    controlRunId: string;
    distributedRunId?: string;
    issue?: string;
}> {
    if (!requestedControlRunId && requestedDistributedRunId) {
        return {
            controlRunId: '',
            issue: 'Requested diagnostic distributed run has no control-run context. No substitute was selected.'
        };
    }
    if (!requestedControlRunId) {
        return { controlRunId: '' };
    }
    if (!availableControlRunIds.includes(requestedControlRunId)) {
        return {
            controlRunId: '',
            issue: 'Requested diagnostic control run is unavailable. No substitute was selected.'
        };
    }
    if (!requestedDistributedRunId) {
        return { controlRunId: requestedControlRunId };
    }
    const distributedRun = distributedRuns.find(
        (run) => run.distributedRunId === requestedDistributedRunId
    );
    if (!distributedRun) {
        return {
            controlRunId: requestedControlRunId,
            issue: 'Requested diagnostic distributed run is unavailable. No substitute was selected.'
        };
    }
    if (distributedRun.controlRunId !== requestedControlRunId) {
        return {
            controlRunId: requestedControlRunId,
            issue: 'Requested diagnostic distributed run does not belong to the requested control run.'
        };
    }
    return {
        controlRunId: requestedControlRunId,
        distributedRunId: requestedDistributedRunId
    };
}
