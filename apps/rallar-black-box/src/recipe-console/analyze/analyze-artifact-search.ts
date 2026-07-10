import {
    searchDistributedArtifactEvidence,
    type DistributedArtifactEvidenceSearchResult,
} from '@shared-test/rallar-bb-test/mod.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';

export function deriveAnalyzeArtifactSearchResult(
    model: AnalyzeArtifactModel,
    urlState: RecipeConsoleUrlState,
): DistributedArtifactEvidenceSearchResult {
    return searchDistributedArtifactEvidence(model.evidenceIndex, {
        query: urlState.historyQuery,
        agentId: urlState.agentId,
        recipeId: urlState.recipeId,
        commandId: urlState.commandId,
        status: urlState.status,
        severity: urlState.diagnosticSeverity,
        transport: urlState.transport,
        fromEpochMs: urlState.from,
        toEpochMs: urlState.to,
    });
}
