import path from 'node:path';

import type { ControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/control-snapshots.ts';

import type { WorldFleetArtifactDependencies } from './run-world-fleet-distributed-recipe.ts';

interface ManifestArtifactFiles {
    readonly artifactDir: string;
    readonly bundle: ControlDistributedRunArtifactBundle;
}

export async function writeManifestArtifactFiles(
    { artifactDir, bundle }: ManifestArtifactFiles,
    artifacts: WorldFleetArtifactDependencies
): Promise<'written' | 'unavailable'> {
    let status: 'written' | 'unavailable' = 'written';
    await artifacts.writeFile(path.join(artifactDir, 'artifact-bundle.json'), JSON.stringify(bundle, null, 2) + '\n')
        .catch(() => {
            status = 'unavailable';
        });
    for (const [fileName, contents] of Object.entries(bundle.files)) {
        if (!safeArtifactBundleFileName(fileName)) {
            continue;
        }
        await artifacts.writeFile(
            path.join(artifactDir, fileName),
            contents.endsWith('\n') ? contents : `${contents}\n`
        )
            .catch(() => {
                status = 'unavailable';
            });
    }
    return status;
}

function safeArtifactBundleFileName(fileName: string): boolean {
    return fileName.length > 0 && !/[\0/\\]/.test(fileName) &&
        !['.', '..', 'source-manifest.json', 'artifact-bundle.json', 'evidence-export.json'].includes(fileName);
}
