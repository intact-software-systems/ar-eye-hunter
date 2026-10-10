import { once } from 'node:events';
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';
import type { TestContext } from 'vitest';

import type { ControlDistributedRunArtifactBundle, ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import { decodeControlDistributedRunArtifactBundle } from '../../shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';

import {
    runWorldFleetDistributedRecipe,
    type WorldFleetDistributedRecipeDependencies
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
        expect.soft(requests).toEqual(['POST /distributed-runs/resolve-targets']);
        await expect.soft(readdir(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
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
            expect.soft(requests).toEqual(expectedPaths.slice(0, effectCount[phase]));
            await expect.soft(readdir(path.join(directory, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
    );

    it('RUN closure refuses unknown non-string artifact content before writes', async (context) => {
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
        await expect(readdir(artifactDir)).rejects.toMatchObject({ code: 'ENOENT' });
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
            'GET /distributed-runs/world-fleet-test-run/artifacts'
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
