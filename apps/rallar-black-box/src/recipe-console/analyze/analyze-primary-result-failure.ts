import type {
    DistributedArtifactEvidenceFailureDetails,
    DistributedArtifactEvidenceIndex,
    DistributedRunAnalysis,
} from '@shared-test/rallar-bb-test/mod.ts';

export type AnalyzePrimaryResultFailure = Readonly<{
    evidenceId: string;
    sourceFile: string;
    failureDetails: DistributedArtifactEvidenceFailureDetails;
}>;

export function deriveAnalyzePrimaryResultFailure(
    analysis: DistributedRunAnalysis,
    evidenceIndex: DistributedArtifactEvidenceIndex,
): AnalyzePrimaryResultFailure | undefined {
    const failedResults = evidenceIndex.entries.filter(entry =>
        entry.kind === 'result' && entry.status === 'failed' && entry.failureDetails
    );
    const correlated = analysis.failure?.commandId
        ? failedResults.find(entry =>
              entry.commandId === analysis.failure?.commandId
          )
        : undefined;
    const entry = correlated ?? failedResults[0];
    return entry?.failureDetails
        ? {
              evidenceId: entry.id,
              sourceFile: entry.sourceFile,
              failureDetails: entry.failureDetails,
          }
        : undefined;
}
