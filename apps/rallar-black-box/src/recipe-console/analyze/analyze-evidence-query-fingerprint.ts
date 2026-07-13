import type { DistributedArtifactEvidenceWindowQuery } from
    '@shared-test/rallar-bb-test/mod.ts';

export function analyzeEvidenceQueryFingerprint(
    operationGeneration: number,
    query: DistributedArtifactEvidenceWindowQuery,
): string {
    return JSON.stringify([
        operationGeneration,
        query.query ?? null,
        query.agentId ?? null,
        query.recipeId ?? null,
        query.commandId ?? null,
        query.status ?? null,
        query.severity ?? null,
        query.transport ?? null,
        query.category ?? null,
        query.fromEpochMs ?? null,
        query.toEpochMs ?? null,
    ]);
}
