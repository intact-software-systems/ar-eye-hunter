// @vitest-environment happy-dom
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { createBlackBoxBrowserRallarRuntimeDependency } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
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
import {
    RALLAR_BLACK_BOX_BARRIER_RESOLVED_TOPIC,
    type ControlBarrierEnvelope
} from '../../shared-test/rallar-bb-test/barrier/control-barrier-protocol.ts';
import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import {
    createDefaultRallarBlackBoxBrowserControlAgent,
    createRallarBlackBoxBrowserControlAgent
} from '../../shared-test/rallar-bb-test/browser-control-agent.ts';
import { createSpaBrowserRallarRuntime } from '../../shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRuntime
} from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createBrowserTestStorage } from './browser-test-storage.ts';

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

    publishError(event: RallarBlackBoxControlSocketEvent): void {
        this.publishEvent('error', event);
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
        now: Date.now,
        webSocketFactory,
        fetch: () => Promise.reject(new Error('This client uploads no final report.')),
        heartbeatIntervalMs: 60_000,
        statsIntervalMs: 5_000,
        reconnectBaseMs: 600,
        reconnectMaxMs: 5_000
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
    return socket.sent.map((serialized) => {
        const parsed = parseControlClientMessage(serialized);
        if (!parsed.ok) {
            throw new Error(parsed.error);
        }
        return parsed.envelope;
    });
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
    it('advertises actual SPA capture support at registration and after conflicting Configure heartbeat', async () => {
        vi.useFakeTimers();
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));
        try {
            connectToRunOne(client);
            socket.open();
            expect(toSentEnvelopes(socket).find((message) => message.kind === 'register')).toMatchObject({
                identity: { capabilities: { rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling', 'native'] } } }
            });
            await runtime.execute({ kind: 'configure', config: { control: { providerMode: 'simulated' } } });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(toSentEnvelopes(socket).filter((message) => message.kind === 'heartbeat').at(-1)).toMatchObject({
                identity: { providerMode: 'simulated', capabilities: { rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling', 'native'] } } }
            });
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('capture dependency fix1 uses the owned clock for registration, heartbeat and inbound message timestamps', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(99_000);
        let now = 1_234;
        const runtime = createDefaultRallarBlackBoxTestRuntime({ now: () => now });
        const socket = new FakeControlSocket();
        const options = { ...toClientOptions(runtime, () => socket), now: () => now, statsIntervalMs: 0 };
        const client = new RallarBlackBoxControlClient(options);
        try {
            connectToRunOne(client);
            socket.open();
            expect(toSentEnvelopes(socket).find((message) => message.kind === 'register')).toMatchObject({
                atEpochMs: 1_234,
                identity: { updatedAtEpochMs: 1_234 }
            });
            expect(client.getSnapshot().connectedAtEpochMs).toBe(1_234);
            now = 5_678;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(toSentEnvelopes(socket).filter((message) => message.kind === 'heartbeat').at(-1)).toMatchObject({
                atEpochMs: 5_678,
                identity: { updatedAtEpochMs: 5_678 }
            });
            expect(client.getSnapshot().lastHeartbeatAtEpochMs).toBe(5_678);
            now = 9_012;
            socket.publishMessage('invalid control message');
            expect(client.getSnapshot().lastMessageAtEpochMs).toBe(9_012);
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('default browser construction advertises installed support over the control wire', async () => {
        // This browser bootstrap reads test-owned storage.
        vi.stubGlobal('localStorage', createBrowserTestStorage());
        vi.stubGlobal('sessionStorage', createBrowserTestStorage());
        const sockets: FakeControlSocket[] = [];
        vi.stubGlobal(
            'WebSocket',
            class extends FakeControlSocket {
                constructor() {
                    super();
                    sockets.push(this);
                }
            }
        );
        const volatileLimits = new BlackBoxRallarVolatileLimits();
        const targetWindow: EventTarget & BlackBoxRallarRuntimeInstallationTarget = new EventTarget();
        const page = createBlackBoxRallarRuntime({
            facade: createBlackBoxBrowserRallarRuntimeDependency({ readVolatileSessionLimits: volatileLimits.get }),
            volatileLimits,
            targetWindow,
            clock: { now: Date.now },
            readDocument: () => ({ timeOrigin: 1, origin: 'https://test.invalid' }),
            delay: async () => undefined
        });
        vi.stubGlobal('window', Object.assign(targetWindow, { __blackBoxRallar: page }));
        const agent = createDefaultRallarBlackBoxBrowserControlAgent({
            search:
                '?mode=control&provider=browser-rallar&apiBaseUrl=http%3A%2F%2F127.0.0.1%3A9999&rallarRestoreSession=1&autoConnect=1&runId=run-1&agentId=agent-1',
            env: {},
            hash: ''
        });
        try {
            expect(await agent.start()).toMatchObject({ right: 'connecting' });
            sockets[0].open();
            expect(toSentEnvelopes(sockets[0]).find((message) => message.kind === 'register')).toMatchObject({
                identity: { capabilities: { rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling', 'native'] } } }
            });
        }
        finally {
            try {
                agent.dispose();
                await page.close();
            }
            finally {
                vi.unstubAllGlobals();
            }
        }
    });

    it('injected simulated runtime stays unsupported under a browser bootstrap and later Configure', async () => {
        vi.stubGlobal('localStorage', createBrowserTestStorage());
        vi.stubGlobal('sessionStorage', createBrowserTestStorage());
        vi.useFakeTimers();
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));
        const agent = createRallarBlackBoxBrowserControlAgent({
            bootstrap: resolveRallarBlackBoxBootstrapConfig(
                '?mode=control&provider=browser-rallar&apiBaseUrl=http%3A%2F%2F127.0.0.1%3A9999&rallarRestoreSession=1&autoConnect=1&runId=run-1&agentId=agent-1',
                {},
                ''
            ),
            agentRuntime: { runtime },
            controlClient: client
        });
        try {
            expect(await agent.start()).toMatchObject({ right: 'connecting' });
            socket.open();
            await runtime.execute({ kind: 'configure', config: { control: { providerMode: 'browser-rallar' }, rallar: { crdt: true } } });
            await vi.advanceTimersByTimeAsync(60_000);
            const envelopes = toSentEnvelopes(socket).filter((message) => message.kind === 'register' || message.kind === 'heartbeat');
            expect(envelopes.length).toBeGreaterThan(1);
            for (const message of envelopes) {
                expect(message.identity?.capabilities?.rtcCapture).toBeUndefined();
            }
        }
        finally {
            agent.dispose();
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('executes the same installed runtime it advertises when caller options later change', async () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
        const replacement = createDefaultRallarBlackBoxTestRuntime();
        const socket = new FakeControlSocket();
        const options = toClientOptions(runtime, () => socket);
        const client = new RallarBlackBoxControlClient(options);
        const recipe = { schemaVersion: 1 as const, recipeId: 'same-installed-runtime', commands: [{ kind: 'health' as const }] };
        try {
            Reflect.set(options, 'runtime', replacement);
            connectToRunOne(client);
            socket.open();
            socket.publishMessage(JSON.stringify(toCommandEnvelope('same-runtime-load', { kind: 'recipe.load', recipe })));
            await vi.waitFor(() => expect(toResultEnvelopes(socket, 'same-runtime-load')).toHaveLength(1));
            expect(runtime.state().loadedRecipe).toEqual(recipe);
            expect(replacement.state().loadedRecipe).toBeUndefined();
            expect(toSentEnvelopes(socket).find((message) => message.kind === 'register')).toMatchObject({
                identity: { capabilities: { rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling', 'native'] } } }
            });
        }
        finally {
            client.dispose();
        }
    });

    it('copies declared installed support immutably and preserves a signaling-only provider', () => {
        const modes: ('off' | 'signaling' | 'native')[] = ['off', 'signaling'];
        const port = { ...createSpaBrowserRallarRuntime(), rtcCaptureSupport: { configurationVersion: 1 as const, modes } };
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ rallarRuntime: port });
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));
        try {
            modes.push('native');
            Reflect.deleteProperty(port, 'rtcCaptureSupport');
            expect(Reflect.set(runtime, 'rtcCaptureSupport', undefined)).toBe(false);
            connectToRunOne(client);
            socket.open();
            expect(toSentEnvelopes(socket).find((message) => message.kind === 'register')).toMatchObject({
                identity: { capabilities: { rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling'] } } }
            });
        }
        finally {
            client.dispose();
        }
    });

    it.each(['simulated', 'absent', 'unverified custom'] as const)('%s runtime cannot claim capture from browser configuration', async (kind) => {
        vi.useFakeTimers();
        const custom = { ...createSpaBrowserRallarRuntime() };
        Reflect.deleteProperty(custom, 'rtcCaptureSupport');
        const runtime = kind === 'simulated' ? createDefaultRallarBlackBoxTestRuntime() : createDefaultRallarBlackBoxBrowserTestRuntime({
            ...(kind === 'unverified custom' ? { rallarRuntime: custom } : {})
        });
        await runtime.execute({ kind: 'configure', config: { control: { providerMode: 'browser-rallar' }, rallar: { crdt: true } } });
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));
        try {
            connectToRunOne(client);
            socket.open();
            const registration = toSentEnvelopes(socket).find((message) => message.kind === 'register');
            expect(registration?.kind).toBe('register');
            expect(registration?.identity.capabilities?.rtcCapture).toBeUndefined();
            await vi.advanceTimersByTimeAsync(60_000);
            const heartbeat = toSentEnvelopes(socket).filter((message) => message.kind === 'heartbeat').at(-1);
            expect(heartbeat?.kind).toBe('heartbeat');
            expect(heartbeat?.identity.capabilities?.rtcCapture).toBeUndefined();
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('records the message a socket error event carries as the last error', () => {
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(createDefaultRallarBlackBoxTestRuntime(), () => socket));

        try {
            connectToRunOne(client);
            socket.publishError({ message: 'connect ECONNREFUSED 127.0.0.1:8787' });

            expect(client.getSnapshot().lastError).toBe('connect ECONNREFUSED 127.0.0.1:8787');
        }
        finally {
            client.dispose();
        }
    });

    it('validates control command envelopes', () => {
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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

    it('delivers each snapshot change to subscribers until they unsubscribe', () => {
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(createDefaultRallarBlackBoxTestRuntime(), () => socket));
        const delivered: RallarBlackBoxControlSnapshot['state'][] = [];
        const unsubscribe = client.subscribe((snapshot) => delivered.push(snapshot.state));

        try {
            connectToRunOne(client);
            socket.open();
            unsubscribe();
            client.disconnect();

            expect(delivered[0]).toBe('connecting');
            expect(delivered).toContain('registered');
            expect(delivered).not.toContain('disconnected');
            expect(client.getSnapshot().state).toBe('disconnected');
        }
        finally {
            client.dispose();
        }
    });

    it('names the agent identity from the configured actor, session and scope, reading no key a configuration never writes', async () => {
        const socket = new FakeControlSocket();
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-identity-agent',
            config: {
                runId: 'run-1',
                agentId: 'agent-1',
                actor: 'alice',
                sessionId: 'alice-session',
                roomId: 'room-a',
                control: { providerMode: 'simulated' },
                defaults: { providerMode: 'browser-rallar' },
                rallar: {
                    principalId: 'mallory',
                    clientId: 'mallory',
                    clientInstanceId: 'mallory-browser',
                    sessionId: 'mallory-session',
                    groupId: 'mallory-group',
                    providerMode: 'browser-rallar',
                    scope: { applicationId: 'scoped-app', workspaceId: 'scoped-workspace' }
                },
                browser: { label: 'Mallory browser', name: 'firefox', sessionLabel: 'mallory', version: '1', os: 'plan9' }
            }
        });
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));

        try {
            connectToRunOne(client);
            socket.open();

            const [register] = toSentEnvelopes(socket);
            expect(register).toMatchObject({
                kind: 'register',
                identity: {
                    principalId: 'alice',
                    clientId: 'alice',
                    clientInstanceId: 'alice',
                    username: 'alice',
                    sessionId: 'alice-session',
                    groupId: 'room-a',
                    providerMode: 'simulated',
                    sessionLabel: 'alice:alice-session'
                }
            });
            const identity = register?.kind === 'register' ? register.identity : undefined;
            expect(identity).not.toHaveProperty('applicationId');
            expect(identity).not.toHaveProperty('workspaceId');
            expect(identity).not.toHaveProperty('browserName');
            expect(identity).not.toHaveProperty('browserVersion');
            expect(identity).not.toHaveProperty('os');
            expect(JSON.stringify(identity)).not.toContain('mallory');
        }
        finally {
            client.dispose();
        }
    });

    it('reports CRDT runtime capability in register identity when configured for browser Rallar', async () => {
        const socket = new FakeControlSocket();
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-crdt-agent',
            config: {
                runId: 'run-1',
                agentId: 'agent-1',
                apiBaseUrl: 'http://localhost:8080',
                actor: 'alice',
                control: { providerMode: 'browser-rallar' },
                defaults: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'bb-group',
                    providerMode: 'browser-rallar'
                },
                fleet: {
                    browserName: 'chromium',
                    browserVersion: '126',
                    os: 'linux',
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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

    it('streams periodic stats envelopes over the control WebSocket', async () => {
        vi.useFakeTimers();

        const socket = new FakeControlSocket();
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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

            const statsEvent = toEventEnvelopes(socket, 'stats').at(-1)?.payload;
            expect(statsEvent).toMatchObject({ kind: 'stats', topic: 'rallar.bb.stats', payload: { counters: { commands: 1 } } });
            expect(client.getSnapshot().lastStatsAtEpochMs).toBeDefined();
        }
        finally {
            client.dispose();
            vi.useRealTimers();
        }
    });

    it('sends and uploads a redacted final report', async () => {
        const socket = new FakeControlSocket();
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const uploads: Array<{
            url: string;
            body: ControlClientEnvelope;
            authorization: string | null;
        }> = [];
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const parsed = parseControlClientMessage(init?.body);
            if (!parsed.ok) {
                throw new Error(parsed.error);
            }
            uploads.push({
                url: String(input),
                body: parsed.envelope,
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
            expect(uploads[0].body).toMatchObject({ payload: { payload: { summary: expect.anything(), stats: expect.anything() } } });
            for (const report of [uploads[0].body, toEventEnvelopes(socket, 'report')[0]]) {
                expect(report).toHaveProperty('payload.payload');
                expect(report).not.toHaveProperty('payload.payload.results');
                expect(report).not.toHaveProperty('payload.payload.events');
            }
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        vi.stubGlobal('localStorage', createBrowserTestStorage());
        vi.stubGlobal('sessionStorage', createBrowserTestStorage());
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
                    isJsonRecordValue(envelope.payload) && envelope.payload.topic === 'rallar.bb.control.browser_storage_cleaned'
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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

            const statsEvent = toEventEnvelopes(socket, 'stats')[0]?.payload;
            expect(statsEvent).toMatchObject({ payload: { load: { loopCount: 1, latestLoopCommandId: 'loop-1' } } });
        }
        finally {
            client.dispose();
        }
    });

    it('registers without a configured fleet location that names no precision and reports why once', async () => {
        vi.useFakeTimers();
        const socket = new FakeControlSocket();
        const runtime = createDefaultRallarBlackBoxTestRuntime();
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
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const client = createDefaultRallarBlackBoxControlClient({
            runtime,
            heartbeatIntervalMs: 60_000,
            statsIntervalMs: 0
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
            expect(receivers[0]).toBe(globalThis);
        }
        finally {
            client.dispose();
            vi.unstubAllGlobals();
        }
    });

    it('records a barrier resolution addressed to this agent as a runtime event, never as a command', () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const socket = new FakeControlSocket();
        const client = new RallarBlackBoxControlClient(toClientOptions(runtime, () => socket));
        try {
            connectToRunOne(client);
            socket.open();
            const envelope: ControlBarrierEnvelope = {
                kind: 'barrier',
                protocolVersion: 1,
                runId: 'run-1',
                agentId: 'agent-1',
                barrierId: 'scenario-armed',
                resolution: { outcome: 'released', arrivedAgentIds: ['agent-1', 'agent-2'] }
            };

            socket.publishMessage(JSON.stringify(envelope));

            expect(runtime.state().events.filter((event) => event.topic === RALLAR_BLACK_BOX_BARRIER_RESOLVED_TOPIC))
                .toEqual([
                    expect.objectContaining({ payload: { barrierId: 'scenario-armed', resolution: envelope.resolution } })
                ]);
            expect(runtime.state().events.some((event) => event.topic === 'rallar.bb.control.protocol_error'))
                .toBe(false);
        }
        finally {
            client.dispose();
        }
    });
});
