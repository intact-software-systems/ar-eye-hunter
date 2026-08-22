import { describe, expect, it } from 'vitest';

import {
    readDistributedArtifactFiles,
    type ReadDistributedArtifactFilesOutput
} from '../../../apps/rallar-black-box/src/legacy/runner/runs/read-distributed-artifact-files.ts';

describe('distributed artifact file reader', () => {
    it('returns the complete named artifact-import result', async () => {
        const files = [
            artifactFile('distributed-run.json', {
                distributedRunId: 'dist-import',
                controlRunId: 'run-import',
                state: 'passed',
                targetAgentIds: [],
                commandLinks: [],
                rollup: { ok: true, failures: [], summary: { blockingFailures: 0 } },
                manifest: {
                    recipes: [],
                    group: {
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group'
                    }
                }
            }),
            artifactFile('control-run.json', {
                runId: 'run-import',
                agents: [],
                commands: [],
                results: [],
                events: [],
                stats: [],
                reports: [],
                heartbeats: []
            })
        ];
        const result: ReadDistributedArtifactFilesOutput = await readDistributedArtifactFiles(files, 1_000);

        expect(result.artifactFiles).toHaveProperty('distributed-run.json');
        expect(result.analysis.distributedRunId).toBe('dist-import');
        expect(result.snapshots.distributedRun.distributedRunId).toBe('dist-import');
        expect(result.artifactBundle?.distributedRunId).toBe('dist-import');
    });
});

function artifactFile(name: string, value: unknown): File {
    return {
        name,
        text: async () => JSON.stringify(value)
    } as File;
}
