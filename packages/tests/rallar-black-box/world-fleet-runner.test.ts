import { once } from 'node:events';
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';
import type { TestContext } from 'vitest';

import type { ControlEventEnvelope, ControlResultEnvelope } from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlDistributedRunArtifactBundle, ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import { decodeControlDistributedRunArtifactBundle } from '../../shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';

import {
    runWorldFleetDistributedRecipe,
    type WorldFleetDistributedRecipeDependencies,
    type WorldFleetDistributedRecipeRunnerOptions
} from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import { toError } from '../../shared/resilience/to-error.ts';

import { runOwnedTestProcess } from '../hetzner/owned-test-process.ts';

interface WorldFleetCliFixture {
    readonly directory: string;
    readonly bodies: Map<string, unknown>;
    readonly requests: string[];
    readonly authored: RallarBlackBoxDistributedRunManifest;
    readonly manifestPath: string;
    readonly sourceText: string;
    readonly controlUrl: string;
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

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function captureManifest(): RallarBlackBoxDistributedRunManifest {
    const authored: RallarBlackBoxDistributedRunManifest = {
        ...manifest(),
        rtcCaptureMode: 'native',
        recipes: [{
            recipeId: 'health-recipe',
            variables: {},
            recipe: {
                schemaVersion: 1,
                recipeId: 'health-recipe',
                rtcCaptureMode: 'off',
                commands: [
                    { kind: 'configure', config: { rallar: { rtc: { captureMode: 'signaling' } } } },
                    { kind: 'rtc.connect', roomId: 'bb-group', rallar: { rtcCaptureMode: 'native' } }
                ]
            }
        }],
        metadata: { label: 'off', opaque: 'native-signaling-off' }
    };
    return decodeDistributedRunManifest(authored).fold((issues) => {
        throw new Error(toDistributedRunManifestValidationText(issues));
    }, (value) => value);
}

function artifactBundle(input: RallarBlackBoxDistributedRunManifest): ControlDistributedRunArtifactBundle {
    return {
        artifactSchemaVersion: 2,
        distributedRunId: input.distributedRunId,
        generatedAtEpochMs: 3_000,
        files: {
            'distributed-run.json': JSON.stringify(snapshot(input, 'passed')),
            'manifest.json': JSON.stringify(input),
            'control-run.json': '{}'
        }
    };
}

namespace WorldFleetProtocol {
    export interface Input {
        readonly manifest: RallarBlackBoxDistributedRunManifest;
        readonly bodies: Map<string, unknown>;
        readonly requests: string[];
        /** Absent for the ordinary ready-to-passed protocol. */
        readonly states?: readonly ControlDistributedRunSnapshot['state'][];
        /** Absent when exercising optional endpoint authentication. */
        readonly token?: string;
        /** Absent for the ordinary artifact control. */
        readonly artifactFiles?: Readonly<Record<string, unknown>>;
        /** Absent unless one successful response is corrupted. */
        readonly malformed?: { readonly path: string; readonly value: unknown; };
    }
}

class WorldFleetProtocol {
    private readonly scenario: WorldFleetProtocol.Input;
    private polls = 0;

    constructor(scenario: WorldFleetProtocol.Input) {
        this.scenario = scenario;
    }

    async writeResponse(urlInput: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
        const url = new URL(String(urlInput));
        this.scenario.requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        expect(new Headers(init?.headers).get('authorization')).toBe(this.scenario.token === undefined ? null : `Bearer ${this.scenario.token}`);
        if (init?.body) {
            this.scenario.bodies.set(url.pathname, JSON.parse(String(init.body)));
        }
        if (this.scenario.malformed?.path === url.pathname) {
            return jsonResponse(this.scenario.malformed.value);
        }
        if (url.pathname === '/distributed-runs/resolve-targets') {
            return jsonResponse(resolution(this.scenario.manifest));
        }
        if (url.pathname === '/distributed-runs') {
            return jsonResponse(snapshot(this.scenario.manifest, 'draft'), 201);
        }
        if (url.pathname.endsWith('/stage')) {
            return jsonResponse(snapshot(this.scenario.manifest, 'waiting-for-ack'), 202);
        }
        if (url.pathname.endsWith('/start')) {
            return jsonResponse(snapshot(this.scenario.manifest, 'running'), 202);
        }
        if (url.pathname.endsWith('/artifacts')) {
            const bundle = artifactBundle(this.scenario.manifest);
            return jsonResponse({
                ...bundle,
                files: { ...bundle.files, 'target-resolution.json': JSON.stringify(resolution(this.scenario.manifest)), ...this.scenario.artifactFiles }
            });
        }
        const states = this.scenario.states ?? ['ready', 'passed'];
        const state = states[Math.min(this.polls, states.length - 1)];
        this.polls += 1;
        return jsonResponse(snapshot(this.scenario.manifest, state));
    }
}

interface WorldFleetLoopbackResponse {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly protocol: WorldFleetProtocol;
}

function worldFleetFetch(scenario: WorldFleetProtocol.Input): typeof fetch {
    const protocol = new WorldFleetProtocol(scenario);
    return (urlInput, init) => protocol.writeResponse(urlInput, init);
}

async function writeWorldFleetLoopbackResponse(boundary: WorldFleetLoopbackResponse): Promise<void> {
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of boundary.request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const reply = await boundary.protocol.writeResponse(`http://127.0.0.1${boundary.request.url}`, {
            method: boundary.request.method,
            headers: boundary.request.headers.authorization === undefined ? {} : { Authorization: boundary.request.headers.authorization },
            body: chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
        });
        boundary.response.writeHead(reply.status, { 'content-type': 'application/json' });
        boundary.response.end(await reply.text());
    }
    catch (cause) {
        boundary.response.writeHead(500);
        boundary.response.end(toError(cause).message);
    }
}

function createWorldFleetDependencies(fetchPort: typeof fetch): WorldFleetDistributedRecipeDependencies {
    return {
        fetch: fetchPort,
        readManifestText: (filePath) => readFile(filePath, 'utf8'),
        artifacts: {
            mkdir: async (directory) => {
                await mkdir(directory, { recursive: true });
            },
            writeFile: async (filePath, contents) => {
                await writeFile(filePath, contents);
            }
        },
        clock: { now: Date.now, wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) },
        prepareEvidenceExport: async () => undefined,
        log: () => undefined,
        warn: () => undefined
    };
}

async function createWorldFleetCliFixture(
    context: TestContext,
    authoredMode: RallarBlackBoxDistributedRunManifest['rtcCaptureMode'] = 'native'
): Promise<WorldFleetCliFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-cli-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const bodies = new Map<string, unknown>();
    const requests: string[] = [];
    const authored = { ...captureManifest(), rtcCaptureMode: authoredMode };
    const protocol = new WorldFleetProtocol({ manifest: authored, bodies, requests, token: 'owned-test-token' });
    const server = createServer((request, response) => {
        void writeWorldFleetLoopbackResponse({ request, response, protocol });
    });
    context.onTestFinished(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('The owned CLI response server must bind its loopback port.');
    }
    const manifestPath = path.join(directory, 'manifest.json');
    const sourceText = `${JSON.stringify(authored)}\n`;
    await writeFile(manifestPath, sourceText);
    return { directory, bodies, requests, authored, manifestPath, sourceText, controlUrl: `http://127.0.0.1:${address.port}` };
}

describe('world-fleet no-spawn distributed recipe runner', () => {
    it('returns canonical admission failure as data before any HTTP or artifact effect', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-typed-admission-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'manifest.json');
        const sourceText = `${JSON.stringify(captureManifest())}\n`;
        await writeFile(manifestPath, sourceText);
        const requests: string[] = [];
        const artifactDir = path.join(directory, 'artifacts');
        await expect.soft(runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            rtcCaptureMode: 'bogus',
            token: 'owned-test-token',
            artifactDir,
            pollMs: 1,
            timeoutMs: 100
        }, createWorldFleetDependencies(worldFleetFetch({ token: 'owned-test-token', manifest: captureManifest(), bodies: new Map(), requests })))).resolves
            .toMatchObject({
                left: { kind: 'validation', message: 'RTC capture mode must be off, signaling or native.' }
            });
        expect.soft(requests).toEqual([]);
        await expect.soft(readdir(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(manifestPath, 'utf8')).toBe(sourceText);
    });

    it.for(['fetch rejection', 'invalid response JSON'] as const)('returns typed %s at the owned HTTP boundary', async (failure, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-typed-http-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(captureManifest())}\n`);
        const requests: string[] = [];
        const artifactDir = path.join(directory, 'artifacts');
        await expect.soft(runWorldFleetDistributedRecipe(
            {
                controlBaseUrl: 'http://control.test',
                manifestPath,
                token: 'owned-test-token',
                artifactDir,
                pollMs: 1,
                timeoutMs: 100
            },
            createWorldFleetDependencies(async (urlInput, init) => {
                requests.push(`${init?.method ?? 'GET'} ${new URL(String(urlInput)).pathname}`);
                expect(new Headers(init?.headers).get('authorization')).toBe('Bearer owned-test-token');
                if (failure === 'fetch rejection') {
                    throw new Error('owned transport refusal');
                }
                return new Response('owned malformed JSON', { status: 200, headers: { 'Content-Type': 'application/json' } });
            })
        )).resolves.toMatchObject({
            left: {
                kind: 'runtime',
                operation: 'POST /distributed-runs/resolve-targets',
                cause: expect.any(Error)
            }
        });
        expect.soft(requests.filter((request) => request.startsWith('POST'))).toEqual(['POST /distributed-runs/resolve-targets']);
        expect(JSON.parse(await readFile(path.join(artifactDir, 'evidence-export.json'), 'utf8')).operationFailure).not.toBeNull();
    });

    it.for(['bogus', 'OFF', ' native '])('RUN forwarding world-fleet option refuses %s before HTTP or artifacts', async (mode, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-invalid-world-option-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const authored = captureManifest();
        const sourceText = JSON.stringify(authored);
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, sourceText);
        const requests: string[] = [];
        const artifactDir = path.join(directory, 'artifacts');
        const options = {
            controlBaseUrl: 'http://control.test',
            manifestPath,
            rtcCaptureMode: mode,
            token: 'owned-test-token',
            artifactDir,
            pollMs: 1,
            timeoutMs: 100
        };
        const dependencies = createWorldFleetDependencies(worldFleetFetch({ token: 'owned-test-token', manifest: authored, bodies: new Map(), requests }));
        const result = await runWorldFleetDistributedRecipe(options, dependencies).then((outcome) => outcome.left);
        console.info('RUN-world-option-refusal-evidence', JSON.stringify({ mode, requests, error: result instanceof Error ? result.message : result }));
        expect.soft(result).toMatchObject({ kind: 'validation', message: expect.stringContaining('RTC capture mode') });
        expect.soft(requests).toEqual([]);
        await expect.soft(readdir(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(manifestPath, 'utf8')).toBe(sourceText);
    });

    it.for(
        [
            { label: 'omitted', mode: undefined, expected: 'native', authored: 'native' },
            { label: 'blank', mode: '', expected: 'native', authored: 'native' },
            { label: 'whitespace', mode: ' \t ', expected: 'native', authored: 'native' },
            { label: 'off', mode: 'off', expected: 'off', authored: 'native' },
            { label: 'signaling', mode: 'signaling', expected: 'signaling', authored: 'off' },
            { label: 'native', mode: 'native', expected: 'native', authored: 'off' }
        ] as const
    )('RUN forwarding world-fleet option $label reaches each request independently', async (input, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-run-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const authored = { ...captureManifest(), rtcCaptureMode: input.authored };
        const sourceText = `${JSON.stringify(authored)}\n`;
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, sourceText);
        const bodies = new Map<string, unknown>();
        const requests: string[] = [];
        const options = {
            controlBaseUrl: 'http://control.test',
            manifestPath,
            controlRunId: 'owned-live-control',
            rtcCaptureMode: input.mode,
            token: 'owned-test-token',
            artifactDir: path.join(directory, 'artifacts'),
            pollMs: 1,
            timeoutMs: 100
        };
        const dependencies = createWorldFleetDependencies(
            worldFleetFetch({ token: 'owned-test-token', manifest: { ...authored, controlRunId: 'owned-live-control' }, bodies, requests })
        );
        expect((await runWorldFleetDistributedRecipe(options, dependencies)).right).toBe(true);
        const expected = { manifest: { ...authored, controlRunId: 'owned-live-control', rtcCaptureMode: input.expected } };
        console.info('RUN-world-options-evidence', JSON.stringify({ input, bodies: [...bodies] }));
        expect.soft(bodies.get('/distributed-runs/resolve-targets')).toEqual(expected);
        expect.soft(bodies.get('/distributed-runs')).toEqual(expected);
        expect(await readFile(manifestPath, 'utf8')).toBe(sourceText);
        expect(requests.some((value) => value.includes('/agents'))).toBe(false);
    });

    it.for(
        [
            { label: 'omitted', mode: undefined, expected: 'native', authored: 'native' },
            { label: 'blank', mode: '', expected: 'native', authored: 'native' },
            { label: 'whitespace', mode: ' \t ', expected: 'native', authored: 'native' },
            { label: 'off', mode: 'off', expected: 'off', authored: 'native' },
            { label: 'signaling', mode: 'signaling', expected: 'signaling', authored: 'off' },
            { label: 'native', mode: 'native', expected: 'native', authored: 'off' }
        ] as const
    )('RUN forwarding actual world-fleet CLI $label reaches each request independently', async (input, context) => {
        const fixture = await createWorldFleetCliFixture(context, input.authored);
        const argv = [
            '--import',
            'tsx',
            path.resolve(__dirname, '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts'),
            '--control',
            fixture.controlUrl,
            '--manifest',
            fixture.manifestPath,
            '--token',
            'owned-test-token',
            '--artifact-dir',
            path.join(fixture.directory, 'artifacts'),
            '--poll-ms',
            '1',
            '--timeout-ms',
            '1000'
        ];
        if (input.mode !== undefined) {
            argv.push('--rtc-capture-mode', input.mode);
        }
        await runOwnedTestProcess(context, {
            executable: 'node',
            args: argv,
            options: { cwd: path.resolve(__dirname, '../../..'), env: { PATH: process.env.PATH, TMPDIR: fixture.directory } }
        });
        const expected = { manifest: { ...fixture.authored, rtcCaptureMode: input.expected } };
        console.info('RUN-world-CLI-evidence', JSON.stringify({ input, bodies: [...fixture.bodies] }));
        expect.soft(fixture.bodies.get('/distributed-runs/resolve-targets')).toEqual(expected);
        expect.soft(fixture.bodies.get('/distributed-runs')).toEqual(expected);
        expect(await readFile(fixture.manifestPath, 'utf8')).toBe(fixture.sourceText);
        expect(fixture.requests.some((value) => value.includes('/agents'))).toBe(false);
    });

    it.for(['bogus', 'OFF', ' native '])('RUN forwarding actual world-fleet CLI refuses %s before HTTP or artifacts', async (mode, context) => {
        const fixture = await createWorldFleetCliFixture(context);
        const artifactDir = path.join(fixture.directory, 'artifacts');
        const result = await runOwnedTestProcess(context, {
            executable: 'node',
            args: [
                '--import',
                'tsx',
                path.resolve(__dirname, '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts'),
                '--control',
                fixture.controlUrl,
                '--manifest',
                fixture.manifestPath,
                '--token',
                'owned-test-token',
                '--artifact-dir',
                artifactDir,
                '--poll-ms',
                '1',
                '--timeout-ms',
                '1000',
                '--rtc-capture-mode',
                mode
            ],
            options: { cwd: path.resolve(__dirname, '../../..'), env: { PATH: process.env.PATH, TMPDIR: fixture.directory } }
        }).then((output) => ({ output, error: undefined }), (error: unknown) => ({ output: undefined, error }));
        console.info('RUN-world-CLI-refusal-evidence', JSON.stringify({ mode, result, requests: fixture.requests }));
        expect.soft(result.error).toBeInstanceOf(Error);
        expect.soft(fixture.requests).toEqual([]);
        await expect.soft(readdir(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(fixture.manifestPath, 'utf8')).toBe(fixture.sourceText);
    });

    it('RUN closure refuses a malformed manifest before any HTTP or artifact effect', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-invalid-manifest-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const source = { ...captureManifest(), rtcCaptureMode: 'bogus' };
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, JSON.stringify(source));
        const requests: string[] = [];
        const result = await runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            token: 'owned-test-token',
            artifactDir: path.join(directory, 'artifacts'),
            pollMs: 1,
            timeoutMs: 100
        }, createWorldFleetDependencies(worldFleetFetch({ token: 'owned-test-token', manifest: captureManifest(), bodies: new Map(), requests }))).then((
            outcome
        ) => outcome.left);
        expect.soft(result).toMatchObject({ kind: 'validation', message: expect.stringContaining('rtcCaptureMode') });
        expect.soft(requests).toEqual([]);
        await expect.soft(readdir(path.join(directory, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.for(['resolve', 'create', 'stage', 'start', 'status'] as const)(
        'RUN closure refuses malformed successful %s DTO before the next effect',
        async (phase, context) => {
            const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-invalid-dto-'));
            context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
            const authored = captureManifest();
            const manifestPath = path.join(directory, 'manifest.json');
            await writeFile(manifestPath, JSON.stringify(authored));
            const idPath = `/distributed-runs/${authored.distributedRunId}`;
            const pathByPhase = {
                resolve: '/distributed-runs/resolve-targets',
                create: '/distributed-runs',
                stage: `${idPath}/stage`,
                start: `${idPath}/start`,
                status: idPath
            };
            const malformed = phase === 'resolve'
                ? { ...resolution(authored), roleAssignments: [{ role: null }] }
                : { ...snapshot(authored, phase === 'status' ? 'ready' : 'draft'), commandLinks: 'malformed-links' };
            const requests: string[] = [];
            const result = await runWorldFleetDistributedRecipe(
                {
                    controlBaseUrl: 'http://control.test',
                    manifestPath,
                    token: 'owned-test-token',
                    artifactDir: path.join(directory, 'artifacts'),
                    pollMs: 1,
                    timeoutMs: 100
                },
                createWorldFleetDependencies(
                    worldFleetFetch({
                        token: 'owned-test-token',
                        manifest: authored,
                        bodies: new Map(),
                        requests,
                        malformed: { path: pathByPhase[phase], value: malformed }
                    })
                )
            ).then((outcome) => outcome.left);
            console.info('RUN-world-DTO-refusal-evidence', JSON.stringify({ phase, requests, error: result instanceof Error ? result.message : result }));
            expect.soft(result).toEqual({
                kind: 'protocol',
                message: phase === 'resolve' ? 'targetResolution.roleAssignments[0].role must be a non-empty string' : 'commandLinks must be an array'
            });
            const expectedPaths = [
                'POST /distributed-runs/resolve-targets',
                'POST /distributed-runs',
                `POST ${idPath}/stage`,
                `GET ${idPath}`,
                `POST ${idPath}/start`
            ];
            const effectCount = { resolve: 1, create: 2, stage: 3, status: 4, start: 5 };
            expect.soft(requests.slice(0, effectCount[phase])).toEqual(expectedPaths.slice(0, effectCount[phase]));
            expect(requests.slice(effectCount[phase]).every((request) => request.startsWith('GET'))).toBe(true);
            expect(JSON.parse(await readFile(path.join(directory, 'artifacts', 'evidence-export.json'), 'utf8')).operationFailure).not.toBeNull();
        }
    );

    it('refuses non-string bundle content while retaining independent native exports', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-invalid-artifact-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const authored = captureManifest();
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, JSON.stringify(authored));
        const artifactDir = path.join(directory, 'artifacts');
        const result = await runWorldFleetDistributedRecipe(
            {
                controlBaseUrl: 'http://control.test',
                manifestPath,
                token: 'owned-test-token',
                artifactDir,
                pollMs: 1,
                timeoutMs: 100
            },
            createWorldFleetDependencies(
                worldFleetFetch({ token: 'owned-test-token', manifest: authored, bodies: new Map(), requests: [], artifactFiles: { 'unknown.txt': 7 } })
            )
        ).then((outcome) => outcome.left);
        expect(result).toEqual({ kind: 'protocol', message: 'files.unknown.txt must be a string' });
        await expect(readFile(path.join(artifactDir, 'unknown.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(JSON.parse(await readFile(path.join(artifactDir, 'evidence-export.json'), 'utf8')).exports).toContainEqual(
            expect.objectContaining({ fileName: 'artifact-bundle.json', status: 'unavailable' })
        );
    });

    it('RUN closure preserves valid unknown string artifact content', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-extra-artifact-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const authored = captureManifest();
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, JSON.stringify(authored));
        const artifactDir = path.join(directory, 'artifacts');
        const bundle = { ...artifactBundle(authored), files: { ...artifactBundle(authored).files, 'unknown.txt': 'literal extra' } };
        expect(decodeControlDistributedRunArtifactBundle(bundle).right).toEqual(bundle);
        await runWorldFleetDistributedRecipe(
            {
                controlBaseUrl: 'http://control.test',
                manifestPath,
                token: 'owned-test-token',
                artifactDir,
                pollMs: 1,
                timeoutMs: 100
            },
            createWorldFleetDependencies(
                worldFleetFetch({
                    token: 'owned-test-token',
                    manifest: authored,
                    bodies: new Map(),
                    requests: [],
                    artifactFiles: { 'unknown.txt': 'literal extra' }
                })
            )
        );
        expect(await readFile(path.join(artifactDir, 'unknown.txt'), 'utf8')).toBe('literal extra\n');
    });

    it('applies a real controlRunId override before preflight and create', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
        const bodies = new Map<string, unknown>();
        const requests: string[] = [];
        const expectedManifest = { ...manifest(), controlRunId: 'live-control-run' };
        const outcome = await runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            controlRunId: 'live-control-run',
            artifactDir: path.join(directory, 'artifacts'),
            pollMs: 1,
            timeoutMs: 1000
        }, createWorldFleetDependencies(worldFleetFetch({ manifest: expectedManifest, bodies, requests })));
        expect(outcome.right).toBe(true);
        expect(bodies.get('/distributed-runs/resolve-targets')).toEqual({ manifest: expectedManifest });
        expect(bodies.get('/distributed-runs')).toEqual({ manifest: expectedManifest });
    });

    it('exports artifacts before returning a pre-start terminal failure', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
        const artifactDir = path.join(directory, 'artifacts');
        const requests: string[] = [];
        const outcome = await runWorldFleetDistributedRecipe({
            controlBaseUrl: 'http://control.test',
            manifestPath,
            artifactDir,
            pollMs: 1,
            timeoutMs: 1000
        }, createWorldFleetDependencies(worldFleetFetch({ manifest: manifest(), bodies: new Map(), requests, states: ['failed'] })));
        expect(outcome.left).toEqual({ kind: 'terminal', message: 'Distributed run reached failed before start.' });
        expect(requests).toEqual([
            'POST /distributed-runs/resolve-targets',
            'POST /distributed-runs',
            'POST /distributed-runs/world-fleet-test-run/stage',
            'GET /distributed-runs/world-fleet-test-run',
            'GET /distributed-runs/world-fleet-test-run/artifacts',
            'GET /distributed-runs/world-fleet-test-run',
            'GET /runs/world-fleet-template-control-run',
            'GET /runs/world-fleet-template-control-run/events.jsonl',
            'GET /runs/world-fleet-template-control-run/results.jsonl'
        ]);
        await expect(readFile(path.join(artifactDir, 'target-resolution.json'), 'utf8')).resolves.toContain('"targetAgentIds"');
    });

    it('does not write unsafe bundle file names outside the artifact directory', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
        const artifactDir = path.join(directory, 'artifacts');
        const escapedPath = path.join(directory, 'escaped.txt');
        const outcome = await runWorldFleetDistributedRecipe(
            {
                controlBaseUrl: 'http://control.test',
                manifestPath,
                artifactDir,
                pollMs: 1,
                timeoutMs: 1000
            },
            createWorldFleetDependencies(
                worldFleetFetch({ manifest: manifest(), bodies: new Map(), requests: [], artifactFiles: { '../escaped.txt': 'escaped' } })
            )
        );
        expect(outcome.right).toBe(true);
        await expect(readFile(path.join(artifactDir, 'target-resolution.json'), 'utf8')).resolves.toContain('"targetAgentIds"');
        await expect(readFile(escapedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

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

async function createRunnerFixture(): Promise<RunnerFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-world-fleet-runner-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const manifestPath = path.join(directory, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest())}\n`);
    return { artifactDir: path.join(directory, 'artifacts'), manifestPath, server: new ManifestControlServer(manifest()) };
}

interface RunnerOverrides extends Partial<WorldFleetDistributedRecipeRunnerOptions> {
    readonly fetch?: typeof fetch;
    readonly prepareEvidenceExport?: () => Promise<void>;
}

function runFixture(fixture: RunnerFixture, overrides: RunnerOverrides = {}) {
    return runWorldFleetDistributedRecipe({
        controlBaseUrl: 'http://control.test',
        manifestPath: fixture.manifestPath,
        artifactDir: fixture.artifactDir,
        pollMs: 1,
        timeoutMs: 1_000,
        ...overrides
    }, {
        ...createWorldFleetDependencies(overrides.fetch ?? fixture.server.fetch),
        prepareEvidenceExport: overrides.prepareEvidenceExport ?? (async () => undefined)
    });
}

async function readArtifact(fixture: RunnerFixture, fileName: string): Promise<string> {
    return await readFile(path.join(fixture.artifactDir, fileName), 'utf8');
}

describe('manifest no-spawn distributed recipe runner', () => {
    it.each(['passed', 'failed'] as const)('exports late result/event arrivals after caller completion for a %s operation', async (state) => {
        const fixture = await createRunnerFixture();
        fixture.server.pollStates = ['ready', state, state];
        const result: ControlResultEnvelope = {
            kind: 'result',
            protocolVersion: 1,
            runId: 'world-fleet-template-control-run',
            agentId: 'agent-01',
            commandId: 'same-command',
            ok: true
        };
        const lateResult: ControlResultEnvelope = { ...result, ok: false, replayed: true };
        const lateEvent: ControlEventEnvelope = {
            kind: 'event',
            protocolVersion: 1,
            runId: 'world-fleet-template-control-run',
            agentId: 'agent-01',
            atEpochMs: 4_000,
            commandId: 'same-command',
            payload: { late: true }
        };
        const initialControl: ControlRunSnapshot = {
            runId: 'world-fleet-template-control-run',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 3_000,
            agents: [{
                runId: 'world-fleet-template-control-run',
                agentId: 'agent-01',
                connected: true,
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: 1,
                receivedEventCount: 0,
                completedCommandIds: ['same-command'],
                resumeCompletedCommandIds: []
            }],
            commands: [],
            results: [result],
            events: [],
            stats: [],
            reports: [],
            heartbeats: []
        };
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run', jsonResponse(initialControl));
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/results.jsonl', new Response(`${JSON.stringify(result)}\n`));
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response(`${JSON.stringify(result)}\n`));
        const operation = runFixture(fixture, {
            prepareEvidenceExport: async () => {
                // A terminal observation precedes a final producer arrival; awaiting completion makes it visible.
                await Promise.resolve();
                fixture.server.responses.set(
                    'GET /runs/world-fleet-template-control-run',
                    jsonResponse(
                        {
                            ...initialControl,
                            updatedAtEpochMs: 4_000,
                            agents: [{ ...initialControl.agents[0], connected: false, receivedResultCount: 2, receivedEventCount: 1 }],
                            results: [lateResult],
                            events: [lateEvent]
                        } satisfies ControlRunSnapshot
                    )
                );
                fixture.server.responses.set(
                    'GET /runs/world-fleet-template-control-run/results.jsonl',
                    new Response(`${JSON.stringify(result)}\n${JSON.stringify(lateResult)}\n`)
                );
                fixture.server.responses.set(
                    'GET /runs/world-fleet-template-control-run/events.jsonl',
                    new Response(`${JSON.stringify(result)}\n${JSON.stringify(lateResult)}\n${JSON.stringify(lateEvent)}\n`)
                );
            }
        });
        if (state === 'failed') {
            await expect(operation).resolves.toMatchObject({ left: { message: expect.stringContaining('Distributed run did not pass: failed.') } });
        }
        else {
            await expect(operation).resolves.toMatchObject({ right: true });
        }
        const control = JSON.parse(await readArtifact(fixture, 'control-run.json'));
        expect(control).toMatchObject({ agents: [{ connected: false, receivedResultCount: 2, receivedEventCount: 1 }] });
        expect(control.results).toHaveLength(1);
        expect(control.results[0]).toMatchObject({ commandId: 'same-command', ok: false, replayed: true });
        expect(control.events).toHaveLength(1);
        expect(control.events[0].payload).toEqual({ late: true });
        const resultRows = (await readArtifact(fixture, 'results.jsonl')).trim().split('\n').map((row) => JSON.parse(row));
        const eventRows = (await readArtifact(fixture, 'events.jsonl')).trim().split('\n').map((row) => JSON.parse(row));
        expect(resultRows).toHaveLength(2);
        expect(resultRows[1]).toMatchObject({ commandId: 'same-command', ok: false, replayed: true });
        expect(eventRows).toHaveLength(3);
        expect(eventRows[2].payload).toEqual({ late: true });
        expect(JSON.parse(await readArtifact(fixture, 'distributed-run.json')).state).toBe(state);
    });

    it.each([200, 500])('rejects lifecycle preparation failure after success while retaining available evidence (stream HTTP %s)', async (status) => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response('private-stream-body', { status }));
        await expect(runFixture(fixture, {
            prepareEvidenceExport: async () => {
                throw new Error('private-lifecycle-credential');
            }
        })).resolves.toMatchObject({ left: { message: expect.stringContaining('Completion lifecycle preparation failed.') } });
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        const metadata = await readArtifact(fixture, 'evidence-export.json');
        expect(JSON.parse(metadata).operationFailure).toBeNull();
        expect(JSON.parse(metadata).completionLifecycleFailure).toEqual({ code: 'operation-or-write-failed', method: null, pathname: null, httpStatus: null });
        expect(JSON.parse(metadata).exports).toContainEqual(
            expect.objectContaining({ fileName: 'events.jsonl', status: status === 200 ? 'written' : 'unavailable' })
        );
        expect(metadata).not.toContain('private-lifecycle-credential');
        expect(metadata).not.toContain('private-stream-body');
    });

    it('keeps the original operation failure primary when caller completion and export also fail', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.pollStates = ['ready', 'failed'];
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response('private-stream-body', { status: 500 }));
        await expect(runFixture(fixture, {
            prepareEvidenceExport: async () => {
                throw new Error('private-lifecycle-credential');
            }
        })).resolves.toMatchObject({ left: { message: expect.stringContaining('Distributed run did not pass: failed.') } });
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        const metadata = await readArtifact(fixture, 'evidence-export.json');
        expect(JSON.parse(metadata).operationFailure).not.toBeNull();
        expect(JSON.parse(metadata).completionLifecycleFailure).toEqual({ code: 'operation-or-write-failed', method: null, pathname: null, httpStatus: null });
        expect(metadata).not.toContain('private-lifecycle-credential');
    });

    it('keeps lifecycle failure primary over a completion metadata write failure after success', async () => {
        const fixture = await createRunnerFixture();
        await mkdir(path.join(fixture.artifactDir, 'evidence-export.json'), { recursive: true });
        await expect(runFixture(fixture, {
            prepareEvidenceExport: async () => {
                throw new Error('private-lifecycle-credential');
            }
        })).resolves.toMatchObject({ left: { message: expect.stringContaining('Completion lifecycle preparation failed.') } });
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
    });

    it('applies a real controlRunId override to preflight, create and native exports', async () => {
        const fixture = await createRunnerFixture();
        const overridden = { ...manifest(), controlRunId: 'live-control-run' };
        const server = new ManifestControlServer(overridden);
        await runFixture(fixture, { controlRunId: 'live-control-run', fetch: server.fetch });
        expect(server.submittedManifests.map((submitted) => submitted.controlRunId)).toEqual(['live-control-run', 'live-control-run']);
        expect(JSON.parse(await readArtifact(fixture, 'control-run.json')).runId).toBe('live-control-run');
    });

    it('applies the control-run override before validating a sparse source manifest', async () => {
        const fixture = await createRunnerFixture();
        await writeFile(fixture.manifestPath, JSON.stringify({ ...manifest(), controlRunId: undefined }));
        const server = new ManifestControlServer({ ...manifest(), controlRunId: 'live-control-run' });
        await runFixture(fixture, { controlRunId: 'live-control-run', fetch: server.fetch });
        expect(JSON.parse(await readArtifact(fixture, 'control-run.json')).runId).toBe('live-control-run');
        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json')).controlRunId).toBeUndefined();
    });

    it('rejects an inexact target selection before creating a run and preserves source evidence', async () => {
        const fixture = await createRunnerFixture();
        const targets = resolution(manifest());
        fixture.server.responses.set('POST /distributed-runs/resolve-targets', jsonResponse({ ...targets, summary: { ...targets.summary, selected: 2 } }));
        await expect(runFixture(fixture)).resolves.toMatchObject({ left: { message: expect.stringContaining('Target preflight mismatch') } });
        expect(fixture.server.requests).not.toContain('POST /distributed-runs');
        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json'))).toEqual(manifest());
    });

    it('waits through all canonical intermediate states before starting a barrier-enabled run and exporting evidence', async () => {
        const fixture = await createRunnerFixture();
        const barrierManifest = { ...manifest(), barrier: { enabled: true, timeoutMs: 30_000 } };
        await writeFile(fixture.manifestPath, JSON.stringify(barrierManifest));
        const server = new ManifestControlServer(barrierManifest);
        server.pollStates = ['draft', 'resolving-targets', 'staging', 'waiting-for-ack', 'waiting-for-barrier', 'ready', 'running', 'passed'];

        await expect(runFixture(fixture, { fetch: server.fetch })).resolves.toMatchObject({ right: true });

        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json')).barrier).toEqual({ enabled: true, timeoutMs: 30_000 });
        expect(await readArtifact(fixture, 'events.jsonl')).toBe('{"event":1}\n');
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).operationFailure).toBeNull();
    });

    it('keeps pre-start terminal failure primary while retaining native artifacts', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.pollStates = ['failed'];
        await expect(runFixture(fixture)).resolves.toMatchObject({
            left: { message: expect.stringContaining('Distributed run reached failed before start.') }
        });
        expect(JSON.parse(await readArtifact(fixture, 'target-resolution.json')).targetAgentIds).toEqual(['agent-01']);
    });

    it('propagates a failed recipe terminal state after native export', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.pollStates = ['ready', 'failed'];
        await expect(runFixture(fixture)).resolves.toMatchObject({ left: { message: expect.stringContaining('Distributed run did not pass: failed.') } });
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
        await expect(runFixture(fixture)).resolves.toMatchObject({ left: { message: expect.stringContaining('failed with 503') } });
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
        await expect(runFixture(fixture)).resolves.toMatchObject({
            left: { message: expect.stringContaining('GET /distributed-runs/world-fleet-test-run failed with 502') }
        });
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
        await expect(runFixture(fixture, { timeoutMs: -1 })).resolves.toMatchObject({ left: { message: expect.stringContaining('Timed out waiting') } });
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'source-manifest.json'))).toEqual(manifest());
    });

    it('retains independent exports and the original run error when bundle export also fails', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('POST /distributed-runs/world-fleet-test-run/stage', new Response('private-stage-body', { status: 503 }));
        fixture.server.responses.set('GET /distributed-runs/world-fleet-test-run/artifacts', new Response('private-export-body', { status: 500 }));
        await expect(runFixture(fixture)).resolves.toMatchObject({
            left: { message: expect.stringContaining('POST /distributed-runs/world-fleet-test-run/stage failed with 503') }
        });
        expect(await readArtifact(fixture, 'events.jsonl')).toBe('{"event":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'distributed-run.json')).distributedRunId).toBe('world-fleet-test-run');
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).exports).toContainEqual(
            expect.objectContaining({ fileName: 'artifact-bundle.json', status: 'unavailable' })
        );
    });

    it('rejects a passed run when a required stream export fails but retains the other stream', async () => {
        const fixture = await createRunnerFixture();
        fixture.server.responses.set('GET /runs/world-fleet-template-control-run/events.jsonl', new Response('private-stream-body', { status: 500 }));
        await expect(runFixture(fixture)).resolves.toMatchObject({ left: { message: expect.stringContaining('Required evidence export failed') } });
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
        expect(JSON.parse(await readArtifact(fixture, 'evidence-export.json')).exports).toContainEqual(
            expect.objectContaining({ fileName: 'events.jsonl', status: 'unavailable' })
        );
    });

    it('retains individual bundle files when writing the bundle container fails', async () => {
        const fixture = await createRunnerFixture();
        await mkdir(path.join(fixture.artifactDir, 'artifact-bundle.json'), { recursive: true });
        await expect(runFixture(fixture)).resolves.toMatchObject({ left: { message: expect.stringContaining('Required evidence export failed') } });
        expect(JSON.parse(await readArtifact(fixture, 'target-resolution.json')).targetAgentIds).toEqual(['agent-01']);
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
    });

    it('retains all other bundle files when writing one extracted file fails', async () => {
        const fixture = await createRunnerFixture();
        await mkdir(path.join(fixture.artifactDir, 'target-resolution.json'), { recursive: true });
        await expect(runFixture(fixture)).resolves.toMatchObject({ left: { message: expect.stringContaining('Required evidence export failed') } });
        expect(JSON.parse(await readArtifact(fixture, 'manifest.json'))).toEqual(manifest());
        expect(await readArtifact(fixture, 'results.jsonl')).toBe('{"result":1}\n');
    });
});
