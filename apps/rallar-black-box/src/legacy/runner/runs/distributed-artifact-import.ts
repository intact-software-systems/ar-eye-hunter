import type { DistributedRunArtifactFiles } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

export const DISTRIBUTED_ARTIFACT_REQUIRED_FILES = [
    'distributed-run.json',
    'control-run.json'
] as const;

export type DistributedArtifactImportStatus = Readonly<{
    selectedFileCount: number;
    warningCount: number;
    requiredFiles: readonly Readonly<{
        fileName: string;
        loaded: boolean;
    }>[];
}>;

export function distributedArtifactImportStatus(
    files: DistributedRunArtifactFiles,
    warningCount: number
): DistributedArtifactImportStatus {
    return {
        selectedFileCount: Object.values(files).filter((value) => value !== undefined).length,
        warningCount,
        requiredFiles: DISTRIBUTED_ARTIFACT_REQUIRED_FILES.map((fileName) => ({
            fileName,
            loaded: files[fileName] !== undefined
        }))
    };
}
