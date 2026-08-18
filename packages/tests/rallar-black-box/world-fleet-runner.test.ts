import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import {
    applyWorldFleetControlRunIdOverride,
    runWorldFleetDistributedRecipe,
} from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';

function manifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'world-fleet-test-run',
        controlRunId: 'world-fleet-template-control-run',
        displayName: 'World fleet test run',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
        },
        recipes: [
            {
                recipeId: 'health-recipe',
                required: true,
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'health-recipe',
                    commands: [{ kind: 'health', commandId: 'health' }],
                },
            },
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount: 1,
        },
        startMode: 'manual',
    };
}

function resolution(input: RallarBlackBoxDistributedRunManifest): RallarBlackBoxDistributedTargetResolution {
    return {
        group: input.group,
        resolvedAtEpochMs: 2_000,
        staleAfterMs: 30_000,
        targetPolicyMode: input.targetPolicy.mode,
        targetAgentIds: ['agent-01'],
        roleAssignments: [],
        blockers: [],
        summary: {
            agents: 1,
            targetable: 1,
            selected: 1,
            expectedParticipantCount: 1,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {},
        },
    };
}

function snapshot(
    input: RallarBlackBoxDistributedRunManifest,
    state: ControlDistributedRunSnapshot['state'],
): ControlDistributedRunSnapshot {
    return {
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId ?? 'world-fleet-template-control-run',
        manifest: input,
        state,
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        targetAgentIds: ['agent-01'],
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: state === 'ready' || state === 'running' || state === 'passed' ? 1 : 0,
                passedParticipants: state === 'passed' ? 1 : 0,
                failedParticipants: state === 'failed' ? 1 : 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: state === 'failed' ? 1 : 0,
            },
            failures: [],
        },
    };
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('world-fleet no-spawn distributed recipe runner', () => {
    it('applies a real controlRunId override before preflight and create', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
        const manifestPath = path.join(tmp, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
        const requestBodies: unknown[] = [];
        let getCount = 0;

        await runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            controlRunId: 'live-control-run',
            artifactDir: path.join(tmp, 'artifacts'),
            pollMs: 1,
            timeoutMs: 1_000,
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                if (init?.body) {
                    requestBodies.push(JSON.parse(String(init.body)));
                }
                const overridden = applyWorldFleetControlRunIdOverride(manifest(), 'live-control-run');
                if (url.pathname === '/distributed-runs/resolve-targets') {
                    return jsonResponse(resolution(overridden));
                }
                if (url.pathname === '/distributed-runs' && init?.method === 'POST') {
                    return jsonResponse(snapshot(overridden, 'draft'), 201);
                }
                if (url.pathname.endsWith('/stage')) {
                    return jsonResponse(snapshot(overridden, 'waiting-for-ack'), 202);
                }
                if (url.pathname.endsWith('/start')) {
                    return jsonResponse(snapshot(overridden, 'running'), 202);
                }
                if (url.pathname.endsWith('/artifacts')) {
                    return jsonResponse({
                        artifactSchemaVersion: 2,
                        distributedRunId: overridden.distributedRunId,
                        generatedAtEpochMs: 3_000,
                        files: {
                            'target-resolution.json': JSON.stringify(resolution(overridden)),
                        },
                    });
                }
                getCount += 1;
                return jsonResponse(snapshot(overridden, getCount === 1 ? 'ready' : 'passed'));
            },
        });

        expect(requestBodies.map((body) =>
            (body as { manifest?: RallarBlackBoxDistributedRunManifest }).manifest?.controlRunId
        )).toContain('live-control-run');
    });

    it('exports artifacts before throwing on a pre-start terminal state', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
        const manifestPath = path.join(tmp, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
        const artifactDir = path.join(tmp, 'artifacts');
        const requests: string[] = [];

        await expect(runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            artifactDir,
            pollMs: 1,
            timeoutMs: 1_000,
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
                const testManifest = manifest();
                if (url.pathname === '/distributed-runs/resolve-targets') {
                    return jsonResponse(resolution(testManifest));
                }
                if (url.pathname === '/distributed-runs' && init?.method === 'POST') {
                    return jsonResponse(snapshot(testManifest, 'draft'), 201);
                }
                if (url.pathname.endsWith('/stage')) {
                    return jsonResponse(snapshot(testManifest, 'failed'), 202);
                }
                if (url.pathname.endsWith('/artifacts')) {
                    return jsonResponse({
                        artifactSchemaVersion: 2,
                        distributedRunId: testManifest.distributedRunId,
                        generatedAtEpochMs: 3_000,
                        files: {
                            'target-resolution.json': JSON.stringify(resolution(testManifest)),
                        },
                    });
                }
                return jsonResponse(snapshot(testManifest, 'failed'));
            },
        })).rejects.toThrow('Distributed run reached failed before start.');

        expect(requests).toContain('GET /distributed-runs/world-fleet-test-run/artifacts');
        await expect(readFile(path.join(artifactDir, 'target-resolution.json'), 'utf8'))
            .resolves.toContain('"targetAgentIds"');
    });

    it('does not write unsafe bundle file names outside the artifact directory', async () => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
        const manifestPath = path.join(tmp, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
        const artifactDir = path.join(tmp, 'artifacts');
        const escapedPath = path.join(tmp, 'escaped.txt');
        let getCount = 0;

        await runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            artifactDir,
            pollMs: 1,
            timeoutMs: 1_000,
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                const testManifest = manifest();
                if (url.pathname === '/distributed-runs/resolve-targets') {
                    return jsonResponse(resolution(testManifest));
                }
                if (url.pathname === '/distributed-runs' && init?.method === 'POST') {
                    return jsonResponse(snapshot(testManifest, 'draft'), 201);
                }
                if (url.pathname.endsWith('/stage')) {
                    return jsonResponse(snapshot(testManifest, 'waiting-for-ack'), 202);
                }
                if (url.pathname.endsWith('/start')) {
                    return jsonResponse(snapshot(testManifest, 'running'), 202);
                }
                if (url.pathname.endsWith('/artifacts')) {
                    return jsonResponse({
                        artifactSchemaVersion: 2,
                        distributedRunId: testManifest.distributedRunId,
                        generatedAtEpochMs: 3_000,
                        files: {
                            'target-resolution.json': JSON.stringify(resolution(testManifest)),
                            '../escaped.txt': 'escaped',
                        },
                    });
                }
                getCount += 1;
                return jsonResponse(snapshot(testManifest, getCount === 1 ? 'ready' : 'passed'));
            },
        });

        await expect(readFile(path.join(artifactDir, 'target-resolution.json'), 'utf8'))
            .resolves.toContain('"targetAgentIds"');
        await expect(readFile(escapedPath, 'utf8')).rejects.toThrow();
    });
});
