import { describe, expect, it } from 'vitest';

import { readDistributedArtifactFiles } from '../../../apps/rallar-black-box/src/legacy/runner/runs/read-distributed-artifact-files.ts';
import {
    createControlRunSnapshot,
    createDistributedRunSnapshot
} from '../shared-test/distributed-artifact-analysis/distributed-artifact-files-fixture.ts';

describe('distributed artifact file reader', () => {
    it('returns the complete named artifact-import result', async () => {
        const distributedRun = createDistributedRunSnapshot({
            distributedRunId: 'dist-import',
            controlRunId: 'run-import',
            state: 'passed',
            agentIds: []
        });
        const files = [
            artifactFile('distributed-run.json', JSON.stringify(distributedRun)),
            artifactFile('manifest.json', JSON.stringify(distributedRun.manifest)),
            artifactFile('control-run.json', JSON.stringify(createControlRunSnapshot({ runId: 'run-import' })))
        ];

        const result = await readDistributedArtifactFiles(files, 1_000);

        expect(result.right?.artifactFiles).toHaveProperty('distributed-run.json');
        expect(result.right?.analysis.distributedRunId).toBe('dist-import');
        expect(result.right?.snapshots.distributedRun.distributedRunId).toBe('dist-import');
        expect(result.right?.artifactBundle?.distributedRunId).toBe('dist-import');
    });

    it('returns the analysis rejection for files that hold no distributed run', async () => {
        const result = await readDistributedArtifactFiles(
            [artifactFile('control-run.json', JSON.stringify(createControlRunSnapshot({ runId: 'run-import' })))],
            1_000
        );

        expect(result.left).toEqual({
            fileName: 'distributed-run.json',
            message: 'distributed-run.json is required: the artifacts hold neither a distributed run snapshot nor a failed control request record.'
        });
    });
});

function artifactFile(name: string, text: string): File {
    return {
        name,
        text: async () => text
    } as File;
}
