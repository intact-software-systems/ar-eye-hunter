// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
    createDefaultRallarBlackBoxControlClient,
    RallarBlackBoxControlClient,
    type RallarBlackBoxControlClientOptions,
    type RallarBlackBoxControlSnapshot,
    type RallarBlackBoxControlSocketEvent,
    type RallarBlackBoxControlSocketEventType,
    type RallarBlackBoxControlSocketListener,
    type RallarBlackBoxControlWebSocketFactory
} from '../../../packages/shared-test/rallar-bb-test/control-client.ts';
import {
    parseControlClientMessage,
    parseControlServerMessage,
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestReportFragment,
    RallarBlackBoxTestRuntime,
    RallarBlackBoxTestStatsSnapshot
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

class FakeControlSocket {
    readyState = 0;
    readonly sent: string[] = [];
    private readonly listeners = new Map<RallarBlackBoxControlSocketEventType, Set<RallarBlackBoxControlSocketListener>>();

    addEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void {
        const listeners = this.listeners.get(type) ?? new Set<RallarBlackBoxControlSocketListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: RallarBlackBoxControlSocketEventType, listener: RallarBlackBoxControlSocketListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    send(message: string): void {
        this.sent.push(message);
    }

    close(): void {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this.publishEvent('close', {});
    }

    open(): void {
        this.readyState = 1;
        this.publishEvent('open', {});
    }

    publishMessage(messageText: string): void {
        this.publishEvent('message', { data: messageText });
    }

    private publishEvent(type: RallarBlackBoxControlSocketEventType, event: RallarBlackBoxControlSocketEvent): void {
        this.listeners.get(type)?.forEach((listener) => listener(event));
    }
}

function toClientOptions(
    runtime: RallarBlackBoxTestRuntime,
    webSocketFactory: RallarBlackBoxControlWebSocketFactory
): RallarBlackBoxControlClientOptions {
    return {
        runtime,
        webSocketFactory,
        fetch: () => Promise.reject(new Error('This client uploads no final report.')),
        heartbeatIntervalMs: 60_000,
        statsIntervalMs: 5_000,
        reconnectBaseMs: 600,
        reconnectMaxMs: 5_000,
        onSnapshot: () => undefined
    };
}

function connectToRunOne(client: RallarBlackBoxControlClient): void {
    client.connect({
        url: 'ws://control.example.test',
        runId: 'run-1',
        agentId: 'agent-1',
        completedCommandIds: []
    });
}

function toSentEnvelopes(socket: FakeControlSocket): ControlClientEnvelope[] {
    return socket.sent.map((serialized) => JSON.parse(serialized) as ControlClientEnvelope);
}

function toResultEnvelopes(socket: FakeControlSocket, commandId: string): ControlResultEnvelope[] {
    return toSentEnvelopes(socket)
        .filter((envelope): envelope is ControlResultEnvelope =>
            envelope.kind === 'result' &&
            envelope.commandId === commandId
        );
}

function toEventEnvelopes(socket: FakeControlSocket, kind: 'stats' | 'report'): ControlEventEnvelope[] {
    return toSentEnvelopes(socket)
        .filter((envelope): envelope is ControlEventEnvelope => envelope.kind === kind);
}

function toCommandEnvelope(
    commandId: string,
    command: RallarBlackBoxTestCommand
): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId,
        command
    };
}

function createMemoryStorage(): Pick<Storage, 'setItem' | 'getItem' | 'clear'> {
    const values = new Map<string, string>();
    return {
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
        getItem: (key: string) => values.get(key) ?? null,
        clear: () => {
            values.clear();
        }
    };
}

function toConfigureCommand(): RallarBlackBoxTestCommand {
    return {
        kind: 'configure',
        config: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice'
        }
    };
}

describe('shared rallar black-box control client', () => {
    it('exports the control client constructor and snapshot type', () => {
        expect(RallarBlackBoxControlClient).toBeTypeOf('function');
        const snapshot: RallarBlackBoxControlSnapshot = {
            state: 'idle',
            reconnectAttempt: 0,
            sentCount: 0,
            receivedCount: 0
        };
        expect(snapshot.state).toBe('idle');
    });

    it('validates control command toSentEnvelopes', () => {
        const valid = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('configure-1', toConfigureCommand())),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(valid.ok).toBe(true);
        expect(valid.ok ? valid.envelope.commandId : '').toBe('configure-1');

        const loop = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('loop-1', {
                kind: 'loop',
                commandId: 'loop-1',
                count: 2,
                commands: [{ kind: 'health', commandId: 'loop-health' }]
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(loop.ok).toBe(true);

        const wait = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('wait-1', {
                kind: 'wait',
                commandId: 'wait-1',
                timeoutMs: 500,
                match: {
                    kind: 'message',
                    topic: 'rallar.bb.ws.message',
                    transport: 'ws',
                    payloadPath: 'data.topic',
                    contains: 'chat'
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(wait.ok).toBe(true);

        const assertCommand = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('assert-1', {
                kind: 'assert',
                commandId: 'assert-1',
                source: 'state.messages.length',
                operator: 'gte',
                expected: 1
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(assertCommand.ok).toBe(true);

        const directorCommand = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('director-relay-1', {
                kind: 'director.relay.start',
                commandId: 'director-relay-1',
                handle: 'relay-1',
                roomId: 'room-1',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                topicId: 'app.test.director',
                intentTypeId: 'app.test.director.intent',
                outputTypeId: 'app.test.director.output',
                heartbeatIntervalMs: 300,
                snapshotIntervalMs: 500
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(directorCommand.ok).toBe(true);

        const versionedRecipeLoad = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('recipe-load-versioned-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-versioned-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'versioned-health',
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'versioned-health-1'
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(versionedRecipeLoad.ok).toBe(true);
        expect(versionedRecipeLoad.ok ? versionedRecipeLoad.envelope.command.commandId : '').toBe(
            'recipe-load-versioned-1'
        );

        const rtcReadinessRecipeLoad = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('recipe-load-rtc-readiness-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-readiness-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-readiness',
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-connect-ready',
                            connection: 'rtc',
                            roomId: 'room-1',
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            transport: 'realtime',
                            readiness: {
                                minReadyPeers: 1,
                                timeoutMs: 10_000,
                                intervalMs: 100
                            }
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(rtcReadinessRecipeLoad.ok).toBe(true);

        const invalidRtcReadinessRecipeLoad = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('recipe-load-rtc-readiness-invalid-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-readiness-invalid-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-readiness-invalid',
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-connect-invalid-ready',
                            connection: 'rtc',
                            readiness: {
                                timeoutMs: 0
                            }
                        }
                    ]
                }
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(invalidRtcReadinessRecipeLoad).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: rtc.readiness.timeoutMs must be >= 1.'
        });

        const invalidRtc = parseControlServerMessage(
            JSON.stringify(toCommandEnvelope('rtc-invalid-room', {
                kind: 'rtc.connect',
                commandId: 'rtc-invalid-room',
                roomId: 'bad room',
                applicationId: 'rallar-server',
                workspaceId: 'default'
            })),
            { runId: 'run-1', agentId: 'agent-1' }
        );
        expect(invalidRtc.ok).toBe(false);
        expect(invalidRtc.ok ? [] : invalidRtc.issues).toEqual([
            {
                path: 'rtc.roomId',
                code: 'invalid-route-id',
                message: expect.stringContaining('Room ID')
            }
        ]);

        const mismatchedRun = parseControlServerMessage(
            JSON.stringify({
                ...toCommandEnvelope('configure-1', toConfigureCommand()),
                runId: 'other-run'
            }),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(mismatchedRun).toEqual({
            ok: false,
            error: 'Control command runId does not match this agent.'
        });

        const unsupportedCommand = parseControlServerMessage(
            JSON.stringify({
                ...toCommandEnvelope('unknown-1', toConfigureCommand()),
                command: {
                    kind: 'script.eval'
                }
            }),
            { runId: 'run-1', agentId: 'agent-1' }
        );

        expect(unsupportedCommand).toEqual({
            ok: false,
            error: 'Control command payload is invalid: Command must be an object with a supported kind.'
        });
    });

    it('registers, dispatches commands, and streams results and events', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));

        try {
            connectToRunOne(client);
            socket.open();

            expect(toSentEnvelopes(socket)[0]).toMatchObject({
                kind: 'register',
                runId: 'run-1',
                agentId: 'agent-1',
                identity: {
                    sessionLabel: 'agent-1'
                }
            });

            socket.publishMessage(JSON.stringify(toCommandEnvelope('configure-1', toConfigureCommand())));

            await vi.waitFor(() => {
                expect(toResultEnvelopes(socket, 'configure-1')).toHaveLength(1);
            });

            expect(toResultEnvelopes(socket, 'configure-1')[0]).toMatchObject({
                kind: 'result',
                commandId: 'configure-1',
                ok: true,
                replayed: false
            });
            expect(
                toSentEnvelopes(socket).some((envelope) =>
                    envelope.kind === 'diagnostic' &&
                    envelope.commandId === 'configure-1'
                )
            ).toBe(true);
            expect(client.getSnapshot()).toMatchObject({
                state: 'registered',
                receivedCount: 1
            });
        }
        finally {
            client.dispose();
        }
    });

    it('reports CRDT runtime capability in register identity when configured for browser Rallar', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-crdt-agent',
            config: {
                runId: 'run-1',
                agentId: 'agent-1',
                apiBaseUrl: 'http://localhost:8080',
                actor: 'alice',
                defaults: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'bb-group',
                    providerMode: 'browser-rallar'
                },
                browser: {
                    name: 'chromium',
                    version: '126',
                    os: 'linux'
                },
                fleet: {
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                    location: {
                        latitude: 52.5333,
                        longitude: 13.3833,
                        label: 'fsn1 worker rack',
                        precision: 'exact'
                    },
                    hostId: 'host-1',
                    agentPoolId: 'pool-a',
                    deploymentId: 'deploy-1',
                    tags: ['canary', 'rtc']
                }
            }
        });
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));

        try {
            connectToRunOne(client);
            socket.open();

            const register = toSentEnvelopes(socket)[0];
            expect(register).toMatchObject({
                kind: 'register',
                identity: {
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                    location: {
                        latitude: 52.5333,
                        longitude: 13.3833,
                        label: 'fsn1 worker rack',
                        precision: 'exact'
                    },
                    hostId: 'host-1',
                    agentPoolId: 'pool-a',
                    deploymentId: 'deploy-1',
                    browserName: 'chromium',
                    browserVersion: '126',
                    os: 'linux',
                    tags: ['canary', 'rtc'],
                    capabilities: {
                        crdt: {
                            supported: true,
                            apiBaseUrlConfigured: true
                        },
                        messaging: {
                            supported: true,
                            carriers: expect.arrayContaining(['ws', 'rtc', 'rtc-with-ws-fallback'])
                        }
                    }
                }
            });
            expect(
                register.kind === 'register'
                    ? register.identity.capabilities?.crdt.transports
                    : []
            ).toContain('rtc-with-ws-fallback');

            const parsed = parseControlClientMessage(JSON.stringify(register));
            expect(parsed.ok).toBe(true);
            expect(parsed.ok ? parsed.envelope : undefined).toMatchObject({
                kind: 'register',
                identity: {
                    region: 'eu-north',
                    provider: 'hetzner',
                    location: {
                        latitude: 52.5333,
                        longitude: 13.3833,
                        label: 'fsn1 worker rack',
                        precision: 'exact'
                    },
                    capabilities: {
                        crdt: {
                            supported: true,
                            transports: expect.arrayContaining(['local-only', 'ws', 'rtc'])
                        },
                        messaging: {
                            supported: true,
                            carriers: expect.arrayContaining(['ws', 'rtc', 'rtc-with-ws-fallback'])
                        }
                    }
                }
            });
        }
        finally {
            client.dispose();
        }
    });

    it('replays cached command results for duplicate command IDs', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));
        const command = JSON.stringify(toCommandEnvelope('configure-1', toConfigureCommand()));

        try {
            connectToRunOne(client);
            socket.open();
            socket.publishMessage(command);

            await vi.waitFor(() => {
                expect(toResultEnvelopes(socket, 'configure-1')).toHaveLength(1);
            });

            socket.publishMessage(command);

            await vi.waitFor(() => {
                expect(toResultEnvelopes(socket, 'configure-1')).toHaveLength(2);
            });

            const results = toResultEnvelopes(socket, 'configure-1');
            expect(results[0].replayed).toBe(false);
            expect(results[1].replayed).toBe(true);
            expect(
                runtime.state().commandHistory
                    .filter((result) => result.commandId === 'configure-1')
            ).toHaveLength(1);
        }
        finally {
            client.dispose();
        }
    });

    it('resumes after reconnect and replays completed results', async () => {
        vi.useFakeTimers();

        const sockets: FakeControlSocket[] = [];
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            ...toClientOptions(runtime, () => {
                const socket = new FakeControlSocket();
                sockets.push(socket);
                return socket;
            }),
            reconnectBaseMs: 25,
            reconnectMaxMs: 25
        });

        try {
            connectToRunOne(client);
            sockets[0].open();
            sockets[0].publishMessage(JSON.stringify(toCommandEnvelope('configure-1', toConfigureCommand())));

            await vi.waitFor(() => {
                expect(toResultEnvelopes(sockets[0], 'configure-1')).toHaveLength(1);
            });

            sockets[0].close();
            expect(client.getSnapshot().state).toBe('reconnecting');

            await vi.advanceTimersByTimeAsync(25);
            expect(sockets).toHaveLength(2);

            sockets[1].open();

            await vi.waitFor(() => {
                expect(toResultEnvelopes(sockets[1], 'configure-1')).toHaveLength(1);
            });

            expect(toSentEnvelopes(sockets[1])[0]).toMatchObject({
                kind: 'register',
                resume: {
                    completedCommandIds: ['configure-1']
                }
            });
            expect(toResultEnvelopes(sockets[1], 'configure-1')[0].replayed).toBe(true);
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('streams periodic stats toSentEnvelopes over the control WebSocket', async () => {
        vi.useFakeTimers();

        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({ ...toClientOptions(runtime, () => socket), statsIntervalMs: 25 });

        try {
            connectToRunOne(client);
            socket.open();

            expect(toEventEnvelopes(socket, 'stats')).toHaveLength(1);

            await runtime.execute({
                ...toConfigureCommand(),
                commandId: 'configure-local-1'
            });

            await vi.advanceTimersByTimeAsync(25);

            const statsEvent = toEventEnvelopes(socket, 'stats').at(-1)?.payload as RallarBlackBoxTestEvent<RallarBlackBoxTestStatsSnapshot>;
            expect(statsEvent.kind).toBe('stats');
            expect(statsEvent.topic).toBe('rallar.bb.stats');
            expect(statsEvent.payload?.counters.commands).toBe(1);
            expect(client.getSnapshot().lastStatsAtEpochMs).toBeDefined();
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('sends and uploads a redacted final report', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const uploads: Array<{
            url: string;
            body: ControlClientEnvelope;
            authorization: string | null;
        }> = [];
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            uploads.push({
                url: String(input),
                body: JSON.parse(String(init?.body)) as ControlClientEnvelope,
                authorization: new Headers(init?.headers).get('authorization')
            });
            return new Response('{}', {
                status: 202
            });
        });
        const client = new RallarBlackBoxControlClient({ ...toClientOptions(runtime, () => socket), fetch, statsIntervalMs: 0 });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
                token: 'run-token-1',
                finalReportUploadUrl: 'http://control.example.test/runs/run-1/agents/agent-1/report',
                completedCommandIds: []
            });
            socket.open();

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-secret-1',
                config: {
                    runId: 'run-1',
                    agentId: 'agent-1',
                    rallar: {
                        token: 'secret-token'
                    }
                }
            });

            client.disconnect();

            await vi.waitFor(() => {
                expect(fetch).toHaveBeenCalledTimes(1);
            });

            expect(toEventEnvelopes(socket, 'report')).toHaveLength(1);
            expect(uploads[0].url).toBe('http://control.example.test/runs/run-1/agents/agent-1/report');
            expect(uploads[0].body.kind).toBe('report');
            expect(uploads[0].authorization).toBe('Bearer run-token-1');
            expect(JSON.stringify(uploads[0].body)).not.toContain('secret-token');
            const uploadedEnvelope = uploads[0].body as ControlEventEnvelope;
            const uploadedReport = (uploadedEnvelope.payload as RallarBlackBoxTestEvent<RallarBlackBoxTestReportFragment>)
                .payload;
            expect(uploadedReport?.summary).toBeDefined();
            expect(uploadedReport?.stats).toBeDefined();
            expect(uploadedReport?.results).toBeUndefined();
            expect(uploadedReport?.events).toBeUndefined();
            const socketReport = (toEventEnvelopes(socket, 'report')[0].payload as RallarBlackBoxTestEvent<RallarBlackBoxTestReportFragment>)
                .payload;
            expect(socketReport?.results).toBeUndefined();
            expect(socketReport?.events).toBeUndefined();
            await vi.waitFor(() => {
                expect(client.getSnapshot().lastReportUploadAtEpochMs).toBeDefined();
            });
            expect(client.getSnapshot().lastReportAtEpochMs).toBeDefined();
        }
        finally {
            client.dispose();
        }
    });

    it('clears browser storage before executing remote reset commands', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        vi.stubGlobal('localStorage', createMemoryStorage());
        vi.stubGlobal('sessionStorage', createMemoryStorage());
        const client = new RallarBlackBoxControlClient({ ...toClientOptions(runtime, () => socket), statsIntervalMs: 0 });

        try {
            localStorage.setItem('rallar-secret', 'persisted');
            sessionStorage.setItem('rallar-session-secret', 'persisted');
            connectToRunOne(client);
            socket.open();
            socket.publishMessage(JSON.stringify(toCommandEnvelope('reset-1', {
                kind: 'reset'
            })));

            await vi.waitFor(() => {
                expect(toResultEnvelopes(socket, 'reset-1')).toHaveLength(1);
            });

            expect(localStorage.getItem('rallar-secret')).toBeNull();
            expect(sessionStorage.getItem('rallar-session-secret')).toBeNull();
            expect(
                toSentEnvelopes(socket).some((envelope) =>
                    envelope.kind === 'diagnostic' &&
                    envelope.commandId === 'reset-1' &&
                    (envelope.payload as RallarBlackBoxTestEvent).topic === 'rallar.bb.control.browser_storage_cleaned'
                )
            ).toBe(true);
        }
        finally {
            client.dispose();
            vi.unstubAllGlobals();
        }
    });

    it('reports a failed final report upload as the snapshot error and a warning diagnostic', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const fetch = vi.fn(async () => new Response('down', { status: 503, statusText: 'Service Unavailable' }));
        const client = new RallarBlackBoxControlClient({ ...toClientOptions(runtime, () => socket), fetch, statsIntervalMs: 0 });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
                finalReportUploadUrl: 'http://control.example.test/runs/run-1/agents/agent-1/report',
                completedCommandIds: []
            });
            socket.open();
            client.disconnect();

            await vi.waitFor(() => {
                expect(client.getSnapshot().lastError).toBe('Final report upload failed: 503 Service Unavailable');
            });
            expect(runtime.state().events.find((event) => event.topic === 'rallar.bb.control.report_upload_failed'))
                .toMatchObject({
                    severity: 'warning',
                    payload: {
                        error: 'Final report upload failed: 503 Service Unavailable',
                        uploadUrl: 'http://control.example.test/runs/run-1/agents/agent-1/report'
                    }
                });
            expect(client.getSnapshot().lastReportUploadAtEpochMs).toBeUndefined();
        }
        finally {
            client.dispose();
        }
    });

    it('streams the runtime stats, including load, over the control socket', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({ ...toClientOptions(runtime, () => socket), statsIntervalMs: 0 });

        try {
            await runtime.execute({
                kind: 'loop',
                commandId: 'loop-1',
                count: 1,
                commands: [{ kind: 'health', commandId: 'loop-health' }]
            });
            connectToRunOne(client);
            socket.open();

            const statsEvent = toEventEnvelopes(socket, 'stats')[0]?.payload as RallarBlackBoxTestEvent<RallarBlackBoxTestStatsSnapshot>;
            expect(statsEvent.payload?.load).toMatchObject({ loopCount: 1, latestLoopCommandId: 'loop-1' });
        }
        finally {
            client.dispose();
        }
    });

    it('registers without a configured fleet location that names no precision and reports why once', async () => {
        vi.useFakeTimers();
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-fleet',
            config: {
                runId: 'run-1',
                agentId: 'agent-1',
                fleet: { region: 'eu-north', location: { latitude: 52.5, longitude: 13.4 } }
            }
        });
        const client = new RallarBlackBoxControlClient({
            ...toClientOptions(runtime, () => socket),
            heartbeatIntervalMs: 25,
            statsIntervalMs: 0
        });

        try {
            connectToRunOne(client);
            socket.open();
            await vi.advanceTimersByTimeAsync(50);

            const register = toSentEnvelopes(socket)[0];
            expect(register.kind === 'register' ? register.identity : undefined).toMatchObject({ region: 'eu-north' });
            expect(register.kind === 'register' ? register.identity.location : 'not a register').toBeUndefined();
            expect(runtime.state().events.filter((event) => event.topic === 'rallar.bb.control.identity_invalid'))
                .toEqual([
                    expect.objectContaining({
                        severity: 'error',
                        payload: {
                            issue: 'identity.location must carry latitude, longitude and an exact or approximate precision'
                        }
                    })
                ]);
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('uploads the final report through the page fetch without rebinding it', async () => {
        const receivers: Array<object | undefined> = [];
        vi.stubGlobal('fetch', function pageFetch (this: object | undefined) {
            receivers.push(this);
            return Promise.resolve(new Response('{}', { status: 202 }));
        });
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = createDefaultRallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0,
            onSnapshot: () => undefined
        });
        vi.stubGlobal('WebSocket', function PageWebSocket () {
            return socket;
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
                finalReportUploadUrl: 'http://control.example.test/runs/run-1/agents/agent-1/report',
                completedCommandIds: []
            });
            socket.open();
            client.disconnect();

            await vi.waitFor(() => {
                expect(receivers).toHaveLength(1);
            });
            expect(receivers[0]).not.toBe(client);
        }
        finally {
            client.dispose();
            vi.unstubAllGlobals();
        }
    });
});
