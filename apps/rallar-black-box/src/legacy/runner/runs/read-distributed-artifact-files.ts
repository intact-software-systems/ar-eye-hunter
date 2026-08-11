import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

export namespace ReadDistributedArtifactFiles {
    export interface Output {
        readonly artifactFiles: DistributedRunArtifactFiles;
        readonly analysis: DistributedRunAnalysis;
        readonly snapshots: ReturnType<typeof distributedArtifactSnapshotsFromFiles>;
        readonly artifactBundle: ReturnType<typeof distributedArtifactBundleFromFiles>;
    }
}

export async function readDistributedArtifactFiles(
    selectedFiles: readonly File[],
    generatedAtEpochMs: number,
): Promise<ReadDistributedArtifactFiles.Output> {
    const fileContents: Record<string, string> = {};
    await Promise.all(selectedFiles.map(async (file) => {
        fileContents[file.name] = await file.text();
    }));
    const artifactFiles: DistributedRunArtifactFiles = fileContents;
    const analysis = analyzeDistributedRunArtifactFiles({
        files: artifactFiles,
        generatedAtEpochMs,
    });
    const snapshots = distributedArtifactSnapshotsFromFiles(
        artifactFiles,
        generatedAtEpochMs,
    );
    const artifactBundle = distributedArtifactBundleFromFiles(
        artifactFiles,
        generatedAtEpochMs,
        analysis.distributedRunId,
    );
    return {
        artifactFiles,
        analysis,
        snapshots,
        artifactBundle,
    };
}
