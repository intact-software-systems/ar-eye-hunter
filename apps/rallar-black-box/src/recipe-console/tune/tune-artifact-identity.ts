import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';

export function retainedTuneArtifactIdentityMatches(
    model: AnalyzeArtifactModel,
    focusRunId: string,
    expectedControlRunId: string | undefined,
): boolean {
    const distributedIds = [
        model.distributedRunId,
        model.identity.distributedRunId,
        model.snapshots.distributedRun.distributedRunId,
        model.analysis.distributedRunId,
    ];
    const snapshotControlRunId = model.snapshots.distributedRun.controlRunId;
    const controlIds = [
        model.controlRunId,
        model.identity.controlRunId,
        snapshotControlRunId,
        model.snapshots.controlRun.runId,
        model.analysis.controlRunId,
    ];
    return distributedIds.every(value => value === focusRunId) &&
        controlIds.every(value => value === undefined || value === snapshotControlRunId) &&
        (!expectedControlRunId || snapshotControlRunId === expectedControlRunId);
}
