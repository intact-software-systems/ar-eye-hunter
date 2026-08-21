import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const managedRunnerPath = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/api-v1-black-box-run.mts'
);

interface ApiV1RunnerInvocation {
    readonly args: readonly string[];
    readonly environment?: NodeJS.ProcessEnv;
}

interface ApiV1RunnerResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

interface StaleFairnessArtifactFixture {
    readonly artifactDir: string;
    readonly staleProofPath: string;
    readonly matrixArtifactPath: string;
}

describe('API-v1 fairness-proof artifact lifecycle', () => {
    it('clears stale proof before a controlled PGlite startup failure', async () => {
        const listener = await startUnrelatedConfigListener();
        const address = listener.address();
        if (!address || typeof address === 'string') {
            await closeServer(listener);
            throw new Error('Occupied-port listener did not expose a TCP address.');
        }

        await withStaleFairnessArtifactFixture(async (fixture) => {
            try {
                const result = await runApiV1BlackBoxRunner({
                    args: [
                        '--backend=pglite-memory',
                        `--port=${address.port}`,
                        '--profile=remote-dry',
                        `--artifact-dir=${fixture.artifactDir}`
                    ]
                });

                expect(result.code).toBe(1);
                expect(result.stderr).toContain('API-v1 child exited before readiness');
                expect(result.stderr).toContain('AddrInUse');
                expect(result.stdout).not.toContain('Matrix profile remote-dry:');
                await expectStaleFairnessProofRemoved(fixture);

                const secondResult = await runApiV1BlackBoxRunner({
                    args: [
                        '--backend=pglite-memory',
                        `--port=${address.port}`,
                        '--profile=remote-dry',
                        `--artifact-dir=${fixture.artifactDir}`
                    ]
                });

                expect(secondResult.code).toBe(1);
                expect(secondResult.stderr).toContain('API-v1 child exited before readiness');
                await expectStaleFairnessProofRemoved(fixture);
            }
            finally {
                await closeServer(listener);
            }
        });
    }, 30_000);

    it('clears stale proof before a managed Postgres failure that precedes migrations', async () => {
        await withStaleFairnessArtifactFixture(async (fixture) => {
            const result = await runApiV1BlackBoxRunner({
                args: [
                    '--backend=postgres',
                    '--profile=api-v1-black-box-medium-scale',
                    '--cluster-only',
                    '--cluster-profile=api-v1-black-box-medium-scale',
                    '--secondary-port=18081',
                    '--tertiary-port=18082',
                    '--run-id=fairness-proof-pre-migration',
                    `--artifact-dir=${fixture.artifactDir}`
                ],
                environment: {
                    ...process.env,
                    DATABASE_URL: 'mysql://localhost/not-a-postgres-database'
                }
            });

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('Managed PostgreSQL isolation requires a PostgreSQL DATABASE_URL.');
            expect(result.stderr).not.toContain('db:migrate failed');
            await expectStaleFairnessProofRemoved(fixture);
        });
    });

    it('clears stale proof before a recipes-only matrix-selection failure', async () => {
        await withStaleFairnessArtifactFixture(async (fixture) => {
            const profile = 'missing-fairness-proof-artifact-profile';
            const result = await runApiV1BlackBoxRunner({
                args: [
                    '--backend=pglite-memory',
                    '--recipes-only',
                    `--profile=${profile}`,
                    `--artifact-dir=${fixture.artifactDir}`
                ]
            });

            expect(result.code).toBe(1);
            expect(result.stderr).toContain(`No recipe matrix entries selected for profile ${profile}`);
            await expectStaleFairnessProofRemoved(fixture);
        });
    });
});

async function runApiV1BlackBoxRunner(
    invocation: ApiV1RunnerInvocation
): Promise<ApiV1RunnerResult> {
    const child = spawn('deno', ['run', '-A', managedRunnerPath, ...invocation.args], {
        cwd: repoRoot,
        env: invocation.environment ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const childExit = new Promise<ApiV1RunnerResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
    const hardTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error('API-v1 fairness-proof artifact runner did not exit within 10000ms.'));
        }, 10_000);
    });

    try {
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        return await Promise.race([childExit, hardTimeout]);
    }
    catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        await childExit.catch(() => undefined);
        throw error;
    }
    finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

async function startUnrelatedConfigListener(): Promise<Server> {
    const listener = createServer((request, response) => {
        if (request.url === '/api/config') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{}');
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '0.0.0.0', () => {
            listener.off('error', reject);
            resolve();
        });
    });
    return listener;
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

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

async function expectStaleFairnessProofRemoved(
    fixture: StaleFairnessArtifactFixture
): Promise<void> {
    await expect(readFile(fixture.staleProofPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.matrixArtifactPath, 'utf8')).resolves.toBe(
        '{"currentRun":"failed"}\n'
    );
}
