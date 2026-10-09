import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JsonComparisonObject } from '@shared-test/json-compare/compare-json-values.ts';

export async function writeManifestArtifactFiles(
    artifactDir: string,
    bundle: JsonComparisonObject
): Promise<'written' | 'unavailable'> {
    let status: 'written' | 'unavailable' = 'written';
    await writeFile(path.join(artifactDir, 'artifact-bundle.json'), JSON.stringify(bundle, null, 2) + '\n')
        .catch(() => {
            status = 'unavailable';
        });
    if (bundle.files === null || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
        return 'unavailable';
    }
    for (const [fileName, contents] of Object.entries(bundle.files)) {
        if (!safeArtifactBundleFileName(fileName)) {
            continue;
        }
        if (typeof contents !== 'string') {
            status = 'unavailable';
            continue;
        }
        await writeFile(path.join(artifactDir, fileName), contents.endsWith('\n') ? contents : `${contents}\n`)
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
