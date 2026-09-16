import type { ControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
    type DistributedRunArtifactRejection,
    type DistributedRunArtifactSnapshots
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { Either } from '@shared/resilience/Either.ts';

export interface ReadDistributedArtifactFilesOutput {
    readonly artifactFiles: DistributedRunArtifactFiles;
    readonly analysis: DistributedRunAnalysis;
    readonly snapshots: DistributedRunArtifactSnapshots;
    readonly artifactBundle: ControlDistributedRunArtifactBundle | undefined;
}

export async function readDistributedArtifactFiles(
    selectedFiles: readonly File[],
    generatedAtEpochMs: number
): Promise<Either<DistributedRunArtifactRejection, ReadDistributedArtifactFilesOutput>> {
    const fileContents: Record<string, string> = {};
    await Promise.all(selectedFiles.map(async (file) => {
        fileContents[file.name] = await file.text();
    }));
    const artifactFiles: DistributedRunArtifactFiles = fileContents;
    return analyzeDistributedRunArtifactFiles({
        files: artifactFiles,
        generatedAtEpochMs
    }).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (artifactAnalysis) =>
            artifactAnalysis.variant === 'distributed-run'
                ? distributedArtifactSnapshotsFromFiles(artifactFiles, generatedAtEpochMs)
                    .mapRight((snapshots) => ({
                        artifactFiles,
                        analysis: artifactAnalysis.analysis,
                        snapshots,
                        artifactBundle: distributedArtifactBundleFromFiles(artifactFiles, generatedAtEpochMs).right
                    }))
                : Either.ofLeft({
                    fileName: 'distributed-run.json',
                    message:
                        `${artifactAnalysis.analysis.failure.title} The artifacts contain no distributed run to import.`
                })
    );
}
