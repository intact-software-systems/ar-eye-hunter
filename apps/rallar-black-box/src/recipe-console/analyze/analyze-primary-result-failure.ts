import type {
    DistributedArtifactEvidenceFailureDetails,
    DistributedArtifactEvidenceIndex,
    DistributedRunAnalysis,
} from '@shared-test/rallar-bb-test/mod.ts';
import { selectPrimaryDistributedArtifactResultFailure } from
    '@shared-test/rallar-bb-test/mod.ts';

export type AnalyzePrimaryResultFailure = Readonly<{
    evidenceId: string;
    sourceFile: string;
    failureDetails: DistributedArtifactEvidenceFailureDetails;
}>;

export function deriveAnalyzePrimaryResultFailure(
    analysis: DistributedRunAnalysis,
    evidenceEntries: DistributedArtifactEvidenceIndex['entries'],
): AnalyzePrimaryResultFailure | undefined {
    const entry = selectPrimaryDistributedArtifactResultFailure(
        evidenceEntries,
        analysis.failure?.commandId,
    );
    return entry?.failureDetails
        ? {
              evidenceId: entry.id,
              sourceFile: entry.sourceFile,
              failureDetails: entry.failureDetails,
          }
        : undefined;
}
