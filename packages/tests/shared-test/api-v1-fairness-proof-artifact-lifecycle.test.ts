import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { withPreparedApiV1BlackBoxArtifacts } from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

interface StaleFairnessArtifactFixture {
    readonly artifactDir: string;
    readonly staleProofPath: string;
    readonly matrixArtifactPath: string;
}

describe('API-v1 fairness-proof artifact lifecycle', () => {
    it('clears stale proof before managed startup and preserves unrelated artifacts on failure', async () => {
        await withStaleFairnessArtifactFixture(async (fixture) => {
            await expect(
                withPreparedApiV1BlackBoxArtifacts({
                    artifactDir: fixture.artifactDir,
                    run: async () => {
                        await expectPreparedArtifacts(fixture);
                        throw new Error('controlled PGlite startup failure');
                    }
                })
            ).rejects.toThrow('controlled PGlite startup failure');

            await expectPreparedArtifacts(fixture);
        });
    });
});

async function withStaleFairnessArtifactFixture(
    run: (fixture: StaleFairnessArtifactFixture) => Promise<void>
): Promise<void> {
    const artifactDir = await mkdtemp(path.join(tmpdir(), 'api-v1-stale-fairness-proof-'));
    const fixture: StaleFairnessArtifactFixture = {
        artifactDir,
        staleProofPath: path.join(artifactDir, 'fairness-proof.json'),
        matrixArtifactPath: path.join(artifactDir, 'matrix-summary.json')
    };
    await writeFile(fixture.staleProofPath, '{"proofs":["stale"]}\n');
    await writeFile(fixture.matrixArtifactPath, '{"currentRun":"failed"}\n');

    try {
        await run(fixture);
    }
    finally {
        await rm(artifactDir, { recursive: true, force: true });
    }
}

async function expectPreparedArtifacts(
    fixture: StaleFairnessArtifactFixture
): Promise<void> {
    await expect(readFile(fixture.staleProofPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.matrixArtifactPath, 'utf8')).resolves.toBe(
        '{"currentRun":"failed"}\n'
    );
}
