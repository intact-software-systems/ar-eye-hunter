import { safeAnalyzeArtifactIdentity } from './analyze-identity-policy.ts';
import type { AnalyzeWorkspaceAction } from './analyze-workspace-state.ts';
import type { AnalyzeArtifactProjection } from './analyze-worker-contract.ts';

export function analyzeCompletionNavigationIdentity(input: Readonly<{
    action: AnalyzeWorkspaceAction;
    expectedDistributedRunId?: string;
    expectedControlRunId?: string;
    projection: AnalyzeArtifactProjection['identity'];
}>): AnalyzeArtifactProjection['identity'] | undefined {
    if (input.action === 'import-local') return input.projection;
    if (!input.expectedDistributedRunId) return undefined;
    const exact = {
        distributedRunId: input.expectedDistributedRunId,
        ...(input.expectedControlRunId
            ? { controlRunId: input.expectedControlRunId }
            : {}),
    };
    const safe = safeAnalyzeArtifactIdentity(exact);
    return safe.distributedRunId === exact.distributedRunId &&
        safe.controlRunId === exact.controlRunId
        ? exact
        : undefined;
}
