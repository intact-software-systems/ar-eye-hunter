import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';
import {
    runWorldFleetDistributedRecipe,
    type WorldFleetDistributedRecipeRunnerOptions
} from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import type { ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

interface RunnerFixture {
    readonly artifactDir: string;
    readonly manifestPath: string;
    readonly server: ManifestControlServer;
}

class ManifestControlServer {
    readonly responses = new Map<string, Response>();
    readonly requests: string[] = [];
    readonly submittedManifests: RallarBlackBoxDistributedRunManifest[] = [];
    pollStates: ControlDistributedRunSnapshot['state'][] = ['ready', 'passed'];
    readonly manifest: RallarBlackBoxDistributedRunManifest;

    constructor(testManifest: RallarBlackBoxDistributedRunManifest) {
        this.manifest = testManifest;
        this.responses.set('POST /distributed-runs/resolve-targets', jsonResponse(resolution(testManifest)));
        this.responses.set('POST /distributed-runs', jsonResponse(snapshot(testManifest, 'draft'), 201));
        this.responses.set(`POST /distributed-runs/${testManifest.distributedRunId}/stage`, jsonResponse(snapshot(testManifest, 'waiting-for-ack')));
        this.responses.set(`POST /distributed-runs/${testManifest.distributedRunId}/start`, jsonResponse(snapshot(testManifest, 'running')));
        this.responses.set(
            `GET /distributed-runs/${testManifest.distributedRunId}/artifacts`,
            jsonResponse({
                artifactSchemaVersion: 2,
                distributedRunId: testManifest.distributedRunId,
                generatedAtEpochMs: 3_000,
                files: {
                    'distributed-run.json': JSON.stringify(snapshot(testManifest, 'passed')),
                    'manifest.json': JSON.stringify(testManifest),
                    'control-run.json': JSON.stringify({ runId: testManifest.controlRunId }),
                    'target-resolution.json': JSON.stringify(resolution(testManifest)),
                    'events.jsonl': '{"preview":true}\n',
                    'results.jsonl': '{"preview":true}\n'
                }
            })
        );
        this.responses.set(`GET /runs/${testManifest.controlRunId}`, jsonResponse({ runId: testManifest.controlRunId, agents: [{ agentId: 'agent-01' }] }));
        this.responses.set(`GET /runs/${testManifest.controlRunId}/events.jsonl`, new Response('{"event":1}\n'));
        this.responses.set(`GET /runs/${testManifest.controlRunId}/results.jsonl`, new Response('{"result":1}\n'));
    }

    readonly fetch: typeof fetch = async (input, init) => {
        const request = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
        this.requests.push(request);
        if (init?.body) {
            const body = JSON.parse(String(init.body));
            if (body.manifest) {
                this.submittedManifests.push(body.manifest);
            }
        }
        const response = this.responses.get(request);
        if (response) {
            return response.clone();
        }
        if (request === `GET /distributed-runs/${this.manifest.distributedRunId}`) {
            return jsonResponse(snapshot(this.manifest, this.pollStates.shift() ?? 'passed'));
        }
        throw new Error('Unexpected control request');
    };
}

function manifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'world-fleet-test-run',
        controlRunId: 'world-fleet-template-control-run',
        displayName: 'World fleet test run',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [
            {
                recipeId: 'health-recipe',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'health-recipe',
                    commands: [{ kind: 'health', commandId: 'health' }]
                },
                variables: {}
            }
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount: 1
        },
        startMode: 'manual',
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        groupAssertions: [],
        metadata: {}
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
            assertionCapabilityBlockedAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {}
        }
    };
}

function snapshot(
    input: RallarBlackBoxDistributedRunManifest,
    state: ControlDistributedRunSnapshot['state']
): ControlDistributedRunSnapshot {
    return {
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
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
                readyParticipants: state === 'ready' || state === 'running' || state === 'passed' ? 1 : 0,
                passedParticipants: state === 'passed' ? 1 : 0,
                failedParticipants: state === 'failed' ? 1 : 0,
                recipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: state === 'failed' ? 1 : 0
            },
            failures: []
        }
    };
}

function jsonResponse<T>(value: T, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function createRunnerFixture(): Promise<RunnerFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
    return { artifactDir: path.join(directory, 'artifacts'), manifestPath, server: new ManifestControlServer(manifest()) };
}

function runFixture(fixture: RunnerFixture, overrides: Partial<WorldFleetDistributedRecipeRunnerOptions> = {}): Promise<void> {
    return runWorldFleetDistributedRecipe({
        controlBaseUrl: 'http://control.test',
        manifestPath: fixture.manifestPath,
        artifactDir: fixture.artifactDir,
        pollMs: 1,
        timeoutMs: 1_000,
        fetchFn: fixture.server.fetch,
        ...overrides
    });
}

async function readArtifact(fixture: RunnerFixture, fileName: string): Promise<string> {
    return await readFile(path.join(fixture.artifactDir, fileName), 'utf8');
}

describe('manifest no-spawn distributed recipe runner', () => {
    it('applies a real controlRunId override to preflight, create and native exports', async () => {
        const fixture = await createRunnerFixture();
        const overridden = { ...manifest(), controlRunId: 'live-control-run' };
        const server = new ManifestControlServer(overridden);
        await runFixture(fixture, { controlRunId: 'live-control-run', fetchFn: server.fetch });
        expect(server.submittedManifests.map((submitted) => submitted.controlRunId)).toEqual(['live-control-run', 'live-control-run']);
        expect(JSON.parse(await readArtifact(fixture, 'control-run.json')).runId).toBe('live-control-run');
    });

    it('applies the control-run override before validating a sparse source manifest', async () => {
        const fixture = await createRunnerFixture();
        await writeFile(fixture.manifestPath, JSON.stringify({ ...manifest(), controlRunId: undefined }));
        const server = new ManifestControlServer({ ...manifest(), controlRunId: 'live-control-run' });
        await runFixture(fixture, { controlRunId: 'live-control-run', fetchFn: server.fetch });
        expect(JSON.parse(await readArtifact(fixture, 'control-run.json')).runId).toBe('live-control-run');
        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json')).controlRunId).toBeUndefined();
    });

    it('rejects an inexact target selection before creating a run and preserves source evidence', async () => {
        const fixture = await createRunnerFixture();
        const targets = resolution(manifest());
        fixture.server.responses.set('POST /distributed-runs/resolve-targets', jsonResponse({ ...targets, summary: { ...targets.summary, selected: 2 } }));
        await expect(runFixture(fixture)).rejects.toThrow('Target preflight mismatch');
        expect(fixture.server.requests).not.toContain('POST /distributed-runs');
        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json'))).toEqual(manifest());
    });

    it('waits through all canonical intermediate states before starting a barrier-enabled run and exporting evidence', async () => {
        const fixture = await createRunnerFixture();
        const barrierManifest = { ...manifest(), barrier: { enabled: true, timeoutMs: 30_000 } };
        await writeFile(fixture.manifestPath, JSON.stringify(barrierManifest));
        const server = new ManifestControlServer(barrierManifest);
        server.pollStates = ['draft', 'resolving-targets', 'staging', 'waiting-for-ack', 'waiting-for-barrier', 'ready', 'running', 'passed'];

        await expect(runFixture(fixture, { fetchFn: server.fetch })).resolves.toBeUndefined();

        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json')).barrier).toEqual({ enabled: true, timeoutMs: 30_000 });
        expect(await readArtifact(fixture, 'events.jsonl')).toBe('{"event":1}\n');
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).operationFailure).toBeNull();
    });

    it('keeps pre-start terminal failure primary while retaining native artifacts', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.pollStates = ['failed'];
        await expect(runFixture(fixture)).rejects.toThrow('Distributed run reached failed before start.');
        expect(JSON.parse(await readArtifact(fixture, 'target-resolution.json')).targetAgentIds).toEqual(['agent-01']);
    });

    it('propagates a failed recipe terminal state after native export', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.pollStates = ['ready', 'failed'];
        await expect(runFixture(fixture)).rejects.toThrow('Distributed run did not pass: failed.');
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
    });

    it('exports direct streams beyond preview bounds and unbounded snapshots without claiming storage completeness', async () => {
        const fixture = await createRunnerFixture();
        const events = Array.from({ length: 250 }, (_, index) => JSON.stringify({ event: index })).join('\n') + '\n';
        const results = Array.from({ length: 251 }, (_, index) => JSON.stringify({ result: index })).join('\n') + '\n';
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response(events));
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/results.jsonl', new Response(results));
        await runFixture(fixture);
        expect(await readArtifact(fixture, 'events.jsonl')).toBe(events);
        expect(await readArtifact(fixture, 'results.jsonl')).toBe(results);
        expect(JSON.parse(await readArtifact(fixture, 'control-run.json')).agents).toEqual([{ agentId: 'agent-01' }]);
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).streamCompleteness).toBe('unverified');
        expect(JSON.parse(await readArtifact(fixture, 'artifact-bundle.json')).artifactSchemaVersion).toBe(2);
    });

    it('preserves direct stream bytes without stripping markers or appending newlines', async () => {
        const fixture = await createRunnerFixture();
        const bytes = Uint8Array.from([239, 187, 191, 123, 125, 13, 10, 123, 125]);
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response(bytes));
        await runFixture(fixture);
        expect(new Uint8Array(await readFile(path.join(fixture.artifactDir, 'events.jsonl')))).toEqual(bytes);
    });

    it('retains native evidence and safe failure metadata after a request rejects', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('POST /distributed-runs/world-fleet-test-run/stage', new Response('credential-bearing-response', { status: 503 }));
        await expect(runFixture(fixture)).rejects.toThrow('failed with 503');
        expect(await readArtifact(fixture, 'events.jsonl')).toBe('{"event":1}\n');
        const metadata = await readArtifact(fixture, 'evidence-export.json');
        expect(JSON.parse(metadata).operationFailure).toEqual({
            code: 'control-http-failed',
            method: 'POST',
            pathname: '/distributed-runs/world-fleet-test-run/stage',
            httpStatus: 503
        });
        expect(metadata).not.toContain('credential-bearing-response');
    });

    it('retains other endpoints when polling and snapshot export both reject', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('GET /distributed-runs/world-fleet-test-run', new Response('private-poll-body', { status: 502 }));
        await expect(runFixture(fixture)).rejects.toThrow('GET /distributed-runs/world-fleet-test-run failed with 502');
        expect(await readArtifact(fixture, 'events.jsonl')).toBe('{"event":1}\n');
        const metadata = JSON.parse(await readArtifact(fixture, 'evidence-export.json'));
        expect(metadata.operationFailure.httpStatus).toBe(502);
        expect(metadata.exports).toContainEqual(
            expect.objectContaining({
                fileName: 'distributed-run.json',
                status: 'unavailable',
                failure: { code: 'control-http-failed', method: 'GET', pathname: '/distributed-runs/world-fleet-test-run', httpStatus: 502 }
            })
        );
    });

    it('retains evidence after the ready wait times out', async () => {
        const fixture = await createRunnerFixture();
        await expect(runFixture(fixture, { timeoutMs: -1 })).rejects.toThrow('Timed out waiting');
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json'))).toEqual(manifest());
    });

    it('retains independent exports and the original run error when bundle export also fails', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('POST /distributed-runs/world-fleet-test-run/stage', new Response('private-stage-body', { status: 503 }));
        fixture.server.responses.set('GET /distributed-runs/world-fleet-test-run/artifacts', new Response('private-export-body', { status: 500 }));
        await expect(runFixture(fixture)).rejects.toThrow('POST /distributed-runs/world-fleet-test-run/stage failed with 503');
        expect(await readArtifact(fixture, 'events.jsonl')).toBe('{"event":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'distributed-run.json')).distributedRunId).toBe('world-fleet-test-run');
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).exports).toContainEqual(
            expect.objectContaining({ fileName: 'artifact-bundle.json', status: 'unavailable' })
        );
    });

    it('rejects a passed run when a required stream export fails but retains the other stream', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response('private-stream-body', { status: 500 }));
        await expect(runFixture(fixture)).rejects.toThrow('Required evidence export failed');
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).exports).toContainEqual(
            expect.objectContaining({ fileName: 'events.jsonl', status: 'unavailable' })
        );
    });

    it('retains individual bundle files when writing the bundle container fails', async () => {
        const fixture = await createRunnerFixture();
        await mkdir(path.join(fixture.artifactDir, 'artifact-bundle.json'), { recursive: true });
        await expect(runFixture(fixture)).rejects.toThrow('Required evidence export failed');
        expect(JSON.parse(await readArtifact(fixture, 'target-resolution.json')).targetAgentIds).toEqual(['agent-01']);
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
    });

    it('retains all other bundle files when writing one extracted file fails', async () => {
        const fixture = await createRunnerFixture();
        await mkdir(path.join(fixture.artifactDir, 'target-resolution.json'), { recursive: true });
        await expect(runFixture(fixture)).rejects.toThrow('Required evidence export failed');
        expect(JSON.parse(await readArtifact(fixture, 'manifest.json'))).toEqual(manifest());
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
    });

    it('does not write unsafe bundle file names outside the artifact directory', async () => {
        const fixture = await createRunnerFixture();
        const key = 'GET /distributed-runs/world-fleet-test-run/artifacts';
        const bundle = await fixture.server.responses.get(key)!.json();
        fixture.server.responses.set(key, jsonResponse({ ...bundle, files: { ...bundle.files, '../escaped.txt': 'escaped' } }));
        await runFixture(fixture);
        await expect(readFile(path.join(fixture.artifactDir, '..', 'escaped.txt'), 'utf8')).rejects.toThrow();
        expect(JSON.parse(await readArtifact(fixture, 'target-resolution.json')).targetAgentIds).toEqual(['agent-01']);
    });
});
