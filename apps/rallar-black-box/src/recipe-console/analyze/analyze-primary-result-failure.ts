import type {
    DistributedArtifactEvidenceFailureDetails,
    DistributedArtifactEvidenceIndex,
    DistributedRunAnalysis
} from '@shared-test/rallar-bb-test/mod.ts';
import { resolvePrimaryDistributedArtifactResultFailure } from '@shared-test/rallar-bb-test/mod.ts';

export type AnalyzePrimaryResultFailure = Readonly<{
    evidenceId: string;
    sourceFile: string;
    failureDetails: DistributedArtifactEvidenceFailureDetails;
}>;

export function deriveAnalyzePrimaryResultFailure(
    analysis: DistributedRunAnalysis,
    evidenceEntries: DistributedArtifactEvidenceIndex['entries']
): AnalyzePrimaryResultFailure | undefined {
    const entry = resolvePrimaryDistributedArtifactResultFailure(
        evidenceEntries,
        analysis.ok ? undefined : analysis.failure.commandId
    );
    return entry?.failureDetails
        ? {
            evidenceId: entry.id,
            sourceFile: entry.sourceFile,
            failureDetails: entry.failureDetails
        }
        : undefined;
}
