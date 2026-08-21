import { describe, expect, it } from 'vitest';
import { createExecuteArtifactDownload } from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-artifact-export.ts';

describe('Recipe Console Execute artifact export', () => {
    it('creates deterministic JSON content and a run-bound filename', () => {
        const artifact = {
            artifactSchemaVersion: 2,
            distributedRunId: 'dist-export-a',
            generatedAtEpochMs: 20,
            files: {
                'distributed-run.json': '{}',
                'manifest.json': '{}',
                'control-run.json': '{}'
            }
        };

        const first = createExecuteArtifactDownload(artifact, 'dist-export-a');
        const second = createExecuteArtifactDownload({ ...artifact }, 'dist-export-a');

        expect(first).toEqual(second);
        expect(first.filename).toBe('dist-export-a-artifact.json');
        expect(first.mediaType).toBe('application/json');
        expect(first.content.endsWith('\n')).toBe(true);
        expect(JSON.parse(first.content)).toEqual(artifact);
    });
});
