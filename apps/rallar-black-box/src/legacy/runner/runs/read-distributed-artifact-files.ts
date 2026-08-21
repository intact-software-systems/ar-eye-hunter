import type { ControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
    type DistributedRunArtifactSnapshots
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

export interface ReadDistributedArtifactFilesOutput {
    readonly artifactFiles: DistributedRunArtifactFiles;
    readonly analysis: DistributedRunAnalysis;
    readonly snapshots: DistributedRunArtifactSnapshots;
    readonly artifactBundle: ControlDistributedRunArtifactBundle | undefined;
}

export async function readDistributedArtifactFiles(
    selectedFiles: readonly File[],
    generatedAtEpochMs: number
): Promise<ReadDistributedArtifactFilesOutput> {
    const fileContents: Record<string, string> = {};
    await Promise.all(selectedFiles.map(async (file) => {
        fileContents[file.name] = await file.text();
    }));
    const artifactFiles: DistributedRunArtifactFiles = fileContents;
    const analysis = analyzeDistributedRunArtifactFiles({
        files: artifactFiles,
        generatedAtEpochMs
    });
    const snapshots = distributedArtifactSnapshotsFromFiles(
        artifactFiles,
        generatedAtEpochMs
    );
    const artifactBundle = distributedArtifactBundleFromFiles(
        artifactFiles,
        generatedAtEpochMs,
        analysis.distributedRunId
    );
    return {
        artifactFiles,
        analysis,
        snapshots,
        artifactBundle
    };
}
