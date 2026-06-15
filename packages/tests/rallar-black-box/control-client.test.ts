// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import type { RallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/types.ts';
import { RallarBlackBoxControlClient } from '../../../apps/rallar-black-box/src/control-client.ts';
import {
    type ControlClientEnvelope,
    type ControlCommandEnvelope,
    type ControlEventEnvelope,
    type ControlResultEnvelope,
    parseControlClientMessage,
    parseControlServerMessage,
} from '../../../apps/rallar-black-box/src/control-protocol.ts';

type Listener = (event: unknown) => void;

class FakeControlSocket {
    readyState = 0;
    readonly sent: string[] = [];
    private readonly listeners = new Map<string, Set<Listener>>();

    addEventListener(type: string, listener: Listener): void {
        const listeners = this.listeners.get(type) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this.emit('close', {});
    }

    open(): void {
        this.readyState = 1;
        this.emit('open', {});
    }

    message(data: unknown): void {
        this.emit('message', { data });
    }

    private emit(type: string, event: unknown): void {
        this.listeners.get(type)?.forEach(listener => listener(event));
    }
}

function envelopes(socket: FakeControlSocket): ControlClientEnvelope[] {
    return socket.sent.map(serialized => JSON.parse(serialized) as ControlClientEnvelope);
}

function resultsFor(socket: FakeControlSocket, commandId: string): ControlResultEnvelope[] {
    return envelopes(socket)
        .filter((envelope): envelope is ControlResultEnvelope =>
            envelope.kind === 'result' &&
            envelope.commandId === commandId
        );
}

function eventsFor(socket: FakeControlSocket, kind: 'stats' | 'report'): ControlEventEnvelope[] {
    return envelopes(socket)
        .filter((envelope): envelope is ControlEventEnvelope => envelope.kind === kind);
}

function commandEnvelope(
    commandId: string,
    command: RallarBlackBoxTestCommand,
): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId,
        command,
    };
}

function memoryStorage(): Pick<Storage, 'setItem' | 'getItem' | 'clear'> {
    const values = new Map<string, string>();
    return {
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
        getItem: (key: string) => values.get(key) ?? null,
        clear: () => {
            values.clear();
        },
    };
}

function configureCommand(): RallarBlackBoxTestCommand {
    return {
        kind: 'configure',
        config: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice',
        },
    };
}

describe('rallar-black-box control client', () => {
    it('validates control command envelopes', () => {
        const valid = parseControlServerMessage(
            JSON.stringify(commandEnvelope('configure-1', configureCommand())),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(valid.ok).toBe(true);
        expect(valid.ok ? valid.envelope.commandId : '').toBe('configure-1');

        const loop = parseControlServerMessage(
            JSON.stringify(commandEnvelope('loop-1', {
                kind: 'loop',
                commandId: 'loop-1',
                count: 2,
                commands: [{ kind: 'health', commandId: 'loop-health' }],
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );
        expect(loop.ok).toBe(true);

        const wait = parseControlServerMessage(
            JSON.stringify(commandEnvelope('wait-1', {
                kind: 'wait',
                commandId: 'wait-1',
                timeoutMs: 500,
                match: {
                    kind: 'message',
                    topic: 'rallar.bb.ws.message',
                    transport: 'ws',
                    payloadPath: 'data.topic',
                    contains: 'chat',
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );
        expect(wait.ok).toBe(true);

        const assertCommand = parseControlServerMessage(
            JSON.stringify(commandEnvelope('assert-1', {
                kind: 'assert',
                commandId: 'assert-1',
                source: 'state.messages.length',
                operator: 'gte',
                expected: 1,
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );
        expect(assertCommand.ok).toBe(true);

        const directorCommand = parseControlServerMessage(
            JSON.stringify(commandEnvelope('director-relay-1', {
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
                snapshotIntervalMs: 500,
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );
        expect(directorCommand.ok).toBe(true);

        const invalidRtc = parseControlServerMessage(
            JSON.stringify(commandEnvelope('rtc-invalid-room', {
                kind: 'rtc.connect',
                commandId: 'rtc-invalid-room',
                roomId: 'bad room',
                applicationId: 'rallar-server',
                workspaceId: 'default',
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );
        expect(invalidRtc.ok).toBe(false);
        expect(invalidRtc.ok ? [] : invalidRtc.issues).toEqual([
            {
                path: 'rtc.roomId',
                code: 'invalid-route-id',
                message: expect.stringContaining('Room ID'),
            },
        ]);

        const mismatchedRun = parseControlServerMessage(
            JSON.stringify({
                ...commandEnvelope('configure-1', configureCommand()),
                runId: 'other-run',
            }),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(mismatchedRun).toEqual({
            ok: false,
            error: 'Control command runId does not match this agent.',
        });

        const unsupportedCommand = parseControlServerMessage(
            JSON.stringify({
                ...commandEnvelope('unknown-1', configureCommand()),
                command: {
                    kind: 'script.eval',
                },
            }),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(unsupportedCommand).toEqual({
            ok: false,
            error: 'Control command payload is invalid: Command must be an object with a supported kind.',
        });
    });

    it('registers, dispatches commands, and streams results and events', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            webSocketFactory: () => socket,
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();

            expect(envelopes(socket)[0]).toMatchObject({
                kind: 'register',
                runId: 'run-1',
                agentId: 'agent-1',
                identity: {
                    sessionLabel: 'agent-1',
                },
            });

            socket.message(JSON.stringify(commandEnvelope('configure-1', configureCommand())));

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'configure-1')).toHaveLength(1);
            });

            expect(resultsFor(socket, 'configure-1')[0]).toMatchObject({
                kind: 'result',
                commandId: 'configure-1',
                ok: true,
                replayed: false,
            });
            expect(envelopes(socket).some(envelope =>
                envelope.kind === 'diagnostic' &&
                envelope.commandId === 'configure-1'
            )).toBe(true);
            expect(client.currentSnapshot()).toMatchObject({
                state: 'registered',
                receivedCount: 1,
            });
        } finally {
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
                    providerMode: 'browser-rallar',
                },
                browser: {
                    name: 'chromium',
                    version: '126',
                    os: 'linux',
                },
                fleet: {
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
                    hostId: 'host-1',
                    agentPoolId: 'pool-a',
                    deploymentId: 'deploy-1',
                    tags: ['canary', 'rtc'],
                },
            },
        });
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            webSocketFactory: () => socket,
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();

            const register = envelopes(socket)[0];
            expect(register).toMatchObject({
                kind: 'register',
                identity: {
                    region: 'eu-north',
                    provider: 'hetzner',
                    datacenter: 'fsn1',
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
                            apiBaseUrlConfigured: true,
                        },
                    },
                },
            });
            expect(
                register.kind === 'register'
                    ? register.identity?.capabilities?.crdt?.transports
                    : [],
            ).toContain('rtc-with-ws-fallback');

            const parsed = parseControlClientMessage(JSON.stringify(register));
            expect(parsed.ok).toBe(true);
            expect(parsed.ok ? parsed.envelope : undefined).toMatchObject({
                kind: 'register',
                identity: {
                    region: 'eu-north',
                    provider: 'hetzner',
                    capabilities: {
                        crdt: {
                            supported: true,
                            transports: expect.arrayContaining(['local-only', 'ws', 'rtc']),
                        },
                    },
                },
            });
        } finally {
            client.dispose();
        }
    });

    it('replays cached command results for duplicate command IDs', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            webSocketFactory: () => socket,
        });
        const command = JSON.stringify(commandEnvelope('configure-1', configureCommand()));

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();
            socket.message(command);

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'configure-1')).toHaveLength(1);
            });

            socket.message(command);

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'configure-1')).toHaveLength(2);
            });

            const results = resultsFor(socket, 'configure-1');
            expect(results[0].replayed).toBe(false);
            expect(results[1].replayed).toBe(true);
            expect(runtime.state().commandHistory
                .filter(result => result.commandId === 'configure-1')).toHaveLength(1);
        } finally {
            client.dispose();
        }
    });

    it('resumes after reconnect and replays completed results', async () => {
        vi.useFakeTimers();

        const sockets: FakeControlSocket[] = [];
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            reconnectBaseMs: 25,
            reconnectMaxMs: 25,
            webSocketFactory: () => {
                const socket = new FakeControlSocket();
                sockets.push(socket);
                return socket;
            },
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            sockets[0].open();
            sockets[0].message(JSON.stringify(commandEnvelope('configure-1', configureCommand())));

            await vi.waitFor(() => {
                expect(resultsFor(sockets[0], 'configure-1')).toHaveLength(1);
            });

            sockets[0].close();
            expect(client.currentSnapshot().state).toBe('reconnecting');

            await vi.advanceTimersByTimeAsync(25);
            expect(sockets).toHaveLength(2);

            sockets[1].open();

            await vi.waitFor(() => {
                expect(resultsFor(sockets[1], 'configure-1')).toHaveLength(1);
            });

            expect(envelopes(sockets[1])[0]).toMatchObject({
                kind: 'register',
                resume: {
                    completedCommandIds: ['configure-1'],
                },
            });
            expect(resultsFor(sockets[1], 'configure-1')[0].replayed).toBe(true);
        } finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('streams periodic stats envelopes over the control WebSocket', async () => {
        vi.useFakeTimers();

        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 25,
            webSocketFactory: () => socket,
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();

            expect(eventsFor(socket, 'stats')).toHaveLength(1);

            await runtime.execute({
                ...configureCommand(),
                commandId: 'configure-local-1',
            });

            await vi.advanceTimersByTimeAsync(25);

            const latestStatsEnvelope = eventsFor(socket, 'stats').at(-1);
            expect(latestStatsEnvelope).toBeDefined();
            const statsEvent = latestStatsEnvelope?.payload as any;
            expect(statsEvent.kind).toBe('stats');
            expect(statsEvent.topic).toBe('rallar.bb.stats');
            expect(statsEvent.payload.counters.commands).toBe(1);
            expect(client.currentSnapshot().lastStatsAtEpochMs).toBeDefined();
        } finally {
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
            authorization?: string;
        }> = [];
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            uploads.push({
                url: String(input),
                body: JSON.parse(String(init?.body ?? '{}')) as ControlClientEnvelope,
                authorization: headers.get('authorization') ?? undefined,
            });
            return new Response('{}', {
                status: 202,
            });
        });
        const client = new RallarBlackBoxControlClient({
            runtime,
            fetch,
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0,
            finalReportUploadUrl: 'http://control.example.test/runs/run-1/agents/agent-1/report',
            token: 'run-token-1',
            webSocketFactory: () => socket,
        });

        try {
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-secret-1',
                config: {
                    runId: 'run-1',
                    agentId: 'agent-1',
                    rallar: {
                        token: 'secret-token',
                    },
                },
            });

            client.disconnect();

            await vi.waitFor(() => {
                expect(fetch).toHaveBeenCalledTimes(1);
            });

            expect(eventsFor(socket, 'report')).toHaveLength(1);
            expect(uploads[0].url).toBe('http://control.example.test/runs/run-1/agents/agent-1/report');
            expect(uploads[0].body.kind).toBe('report');
            expect(uploads[0].authorization).toBe('Bearer run-token-1');
            expect(JSON.stringify(uploads[0].body)).not.toContain('secret-token');
            expect(client.currentSnapshot().lastReportAtEpochMs).toBeDefined();
        } finally {
            client.dispose();
        }
    });

    it('clears browser storage before executing remote reset commands', async () => {
        const socket = new FakeControlSocket();
        const runtime = createRallarBlackBoxTestRuntime();
        vi.stubGlobal('localStorage', memoryStorage());
        vi.stubGlobal('sessionStorage', memoryStorage());
        const client = new RallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0,
            webSocketFactory: () => socket,
        });

        try {
            localStorage.setItem('rallar-secret', 'persisted');
            sessionStorage.setItem('rallar-session-secret', 'persisted');
            client.connect({
                url: 'ws://control.example.test',
                runId: 'run-1',
                agentId: 'agent-1',
            });
            socket.open();
            socket.message(JSON.stringify(commandEnvelope('reset-1', {
                kind: 'reset',
            })));

            await vi.waitFor(() => {
                expect(resultsFor(socket, 'reset-1')).toHaveLength(1);
            });

            expect(localStorage.getItem('rallar-secret')).toBeNull();
            expect(sessionStorage.getItem('rallar-session-secret')).toBeNull();
            expect(envelopes(socket).some(envelope =>
                envelope.kind === 'diagnostic' &&
                envelope.commandId === 'reset-1' &&
                (envelope.payload as any).topic === 'rallar.bb.control.browser_storage_cleaned'
            )).toBe(true);
        } finally {
            client.dispose();
            vi.unstubAllGlobals();
        }
    });
});
