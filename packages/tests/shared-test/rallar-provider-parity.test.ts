import {
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import { toRtcConnectionName } from '../../shared-test/black-box-runner/rtc/rtc-wait-expectations.ts';
import type {
    ControlEventEnvelope,
    ControlResultEnvelope
} from '../../shared-test/rallar-bb-test/control-protocol.ts';
import {
    compareRallarBlackBoxProviderParityReports,
    createRallarBlackBoxProviderParityRecipe,
    createRallarBlackBoxRtcClient,
    createRallarBlackBoxRtcProvider,
    createRallarBlackBoxTestRuntime,
    normalizeBlackBoxRunnerParityReport,
    normalizeRallarBlackBoxRuntimeParityReport,
    toRallarBlackBoxRunnerParityInteractions,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestJsonValue,
    type RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/mod.ts';
import { toJsonResponse } from './fake-remote-browser-control-server.ts';

class FakeRemoteControlServer {
    readonly commands: RallarBlackBoxTestCommand[] = [];
    readonly results: ControlResultEnvelope[] = [];
    readonly events: ControlEventEnvelope[] = [];

    fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const commandMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/commands$/);
        if (init?.method === 'POST' && commandMatch) {
            const runId = decodeURIComponent(commandMatch[1]);
            const agentId = decodeURIComponent(commandMatch[2]);
            const body = JSON.parse(String(init.body ?? '{}')) as {
                command: RallarBlackBoxTestCommand;
            };
            this.recordCommand(runId, agentId, body.command);
            return toJsonResponse({ accepted: true }, 202);
        }

        const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
        if ((!init?.method || init.method === 'GET') && runMatch) {
            return toJsonResponse({
                runId: decodeURIComponent(runMatch[1]),
                results: this.results,
                events: this.events
            });
        }

        return toJsonResponse({ error: 'Not found' }, 404);
    };

    private recordCommand(runId: string, agentId: string, command: RallarBlackBoxTestCommand): void {
        this.commands.push(command);
        const now = 1_000 + this.results.length;
        if (command.kind === 'rtc.send') {
            this.appendSendEvents({ runId, agentId, now, command });
        }
        this.results.push({
            protocolVersion: 1,
            kind: 'result',
            runId,
            agentId,
            commandId: command.commandId ?? 'missing-command',
            ok: true,
            result: {
                commandId: command.commandId ?? 'missing-command',
                kind: command.kind,
                status: 'ok',
                ok: true,
                startedAtEpochMs: now,
                endedAtEpochMs: now + 1,
                durationMs: 1,
                value: {
                    accepted: true,
                    command
                }
            }
        });
    }

    private appendSendEvents(input: {
        readonly runId: string;
        readonly agentId: string;
        readonly now: number;
        readonly command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>;
    }): void {
        const { runId, agentId, now, command } = input;
        const targets = toExpectedConnections(command);
        targets.forEach((connection, index) => {
            this.events.push({
                protocolVersion: 1,
                kind: 'event',
                runId,
                agentId,
                atEpochMs: now + index,
                eventId: `event-${command.commandId}-${index}`,
                commandId: command.commandId ?? 'missing-command',
                payload: {
                    eventId: `event-${command.commandId}-${index}`,
                    kind: 'message',
                    topic: 'rallar.remote.fake.message',
                    atEpochMs: now + index,
                    commandId: command.commandId,
                    connection,
                    transport: command.transport,
                    payload: {
                        data: command.send
                    }
                }
            });
        });
    }
}

function toExpectedConnections(command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>): readonly string[] {
    const parity = command.metadata?.parity;
    const expectedConnections = parity !== null && typeof parity === 'object' && 'expectedConnections' in parity
        ? parity.expectedConnections
        : undefined;
    return Array.isArray(expectedConnections) ? expectedConnections.map(String) : [command.connection ?? 'default'];
}

function assertCommandById(
    commands: readonly RallarBlackBoxTestCommand[],
    commandId: string
): RallarBlackBoxTestCommand {
    const command = commands.find((entry) => entry.commandId === commandId);
    if (!command) {
        throw new Error(`Missing command ${commandId}`);
    }
    return command;
}

function assertRtcSendById(
    commands: readonly RallarBlackBoxTestCommand[],
    commandId: string
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }> {
    const command = assertCommandById(commands, commandId);
    if (command.kind !== 'rtc.send') {
        throw new Error(`Command ${commandId} is not rtc.send`);
    }
    return command;
}

function toResult(
    commandId: string,
    kind: RallarBlackBoxTestResult['kind'],
    status: RallarBlackBoxTestResult['status'] = 'ok'
): RallarBlackBoxTestResult {
    return {
        commandId,
        kind,
        status,
        ok: status === 'ok',
        startedAtEpochMs: 1,
        endedAtEpochMs: 2,
        durationMs: 1
    };
}

describe('rallar provider parity helpers', () => {
    it('builds a portable recipe and runner interactions with explicit omissions', () => {
        const recipe = createRallarBlackBoxProviderParityRecipe({
            transport: 'messages.rtc',
            multicastExpectedConnections: ['bobRtc', 'charlieRtc'],
            broadcastExpectedConnections: ['bobRtc', 'charlieRtc']
        });
        const conversion = toRallarBlackBoxRunnerParityInteractions(recipe, {
            provider: 'rallar-remote-browser'
        });

        expect(recipe.commands.map((command) => command.kind)).toEqual([
            'configure',
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send',
            'health',
            'close',
            'reset'
        ]);
        expect(
            recipe.commands.map((command) => command.metadata?.parity)
                .filter(Boolean)
                .map((parity) => (parity as { operation: string; }).operation)
        )
            .toEqual([
                'configure',
                'connect',
                'send.direct',
                'send.multicast',
                'send.broadcast',
                'health',
                'close',
                'reset'
            ]);
        expect(conversion.omittedCommands.map((command) => command.kind)).toEqual([
            'configure',
            'health',
            'reset'
        ]);
        expect(conversion.interactions).toHaveLength(9);
        expect(JSON.stringify(conversion.interactions)).toContain('"action":"wait"');
        expect(JSON.stringify(conversion.interactions)).toContain('"nextHopPeerIds":["bob-session","charlie-session"]');
    });

    it('keeps the facade runner adapter mapping aligned with the SPA command shape', async () => {
        const recipe = createRallarBlackBoxProviderParityRecipe();
        const conversion = toRallarBlackBoxRunnerParityInteractions(recipe, {
            provider: 'rallar-browser',
            includeReceiveWaits: false
        });
        const executedCommands: RallarBlackBoxTestCommand[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                executedCommands.push(command);
                if (command.kind === 'rtc.send') {
                    context.recordEvent({
                        kind: 'message',
                        topic: 'rallar.bb.parity.echo',
                        commandId: command.commandId,
                        connection: command.connection,
                        transport: command.transport,
                        payload: {
                            data: command.send
                        }
                    });
                }
                if (command.kind === 'close') {
                    context.recordEvent({
                        kind: 'event',
                        topic: 'rallar.bb.parity.closed',
                        commandId: command.commandId,
                        connection: String(command.metadata?.connection ?? 'default'),
                        payload: {
                            closed: true
                        }
                    });
                }
                return {
                    status: 'ok',
                    value: {
                        command
                    },
                    nextStatus: context.state().status
                };
            }
        });

        const report = await executeBlackBox([...conversion.interactions], 0, {
            rtcProviders: {
                'rallar-browser': createRallarBlackBoxRtcProvider(runtime, { commandIdPrefix: 'rallar-bb' })
            }
        });

        expect(report.summary.failure).toBe(0);
        expect(executedCommands.map((command) => command.kind)).toEqual([
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send',
            'close'
        ]);
        const recipeConnect = assertCommandById(recipe.commands, 'parity-connect');
        const actualConnect = assertCommandById(executedCommands, 'parity-connect');
        expect(actualConnect).toMatchObject({
            kind: recipeConnect.kind,
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'rallar-black-box-room',
            transport: 'realtime'
        });
        expect(assertCommandById(executedCommands, 'parity-send-direct')).toMatchObject({
            kind: 'rtc.send',
            send: assertRtcSendById(recipe.commands, 'parity-send-direct').send,
            metadata: {
                parity: {
                    operation: 'send.direct'
                }
            }
        });
        expect(assertCommandById(executedCommands, 'parity-close')).toMatchObject({
            kind: 'close',
            metadata: {
                parity: {
                    operation: 'close'
                },
                connection: 'aliceRtc'
            }
        });
    });

    it('names facade adapter commands from the runner commandId or the generated sequence', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const request = { roomId: 'rallar-black-box-room', applicationId: 'rallar-server' };
        const generated = createRallarBlackBoxRtcClient(
            runtime,
            { ...request, connection: 'aliceRtc', rallarCommandId: 'unread-command-id' },
            { commandIdPrefix: 'rallar-bb' }
        );
        const named = createRallarBlackBoxRtcClient(
            runtime,
            { ...request, connection: 'bobRtc', commandId: 'runner-connect' },
            { commandIdPrefix: 'rallar-bb' }
        );

        await generated.connect();
        await named.connect();

        expect(runtime.state().commandHistory.map((result) => result.commandId)).toEqual([
            'rallar-bb-aliceRtc-connect-1',
            'runner-connect'
        ]);
    });

    it('names the facade adapter connection the way the runner names the RTC connection', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const requests = [
            { actor: 'bob', peerId: 'bob-peer' },
            { name: 'carol', clientId: 'carol-client' },
            { connectionId: 'unread-connection', peerId: 'unread-peer', clientId: 'unread-client' }
        ];

        for (const request of requests) {
            await createRallarBlackBoxRtcClient(runtime, request, { commandIdPrefix: 'rallar-bb' }).connect();
        }

        expect(requests.map(toRtcConnectionName)).toEqual(['bob', 'carol', 'default']);
        expect(runtime.state().commandHistory.map((result) => result.commandId)).toEqual([
            'rallar-bb-bob-connect-1',
            'rallar-bb-carol-connect-1',
            'rallar-bb-default-connect-1'
        ]);
    });

    it('forwards only text actors and rooms and a finite minimum snapshot version, reading past null request fields', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const runtimeCommands = vi.spyOn(runtime, 'execute');
        const requests = [
            {
                name: 'alice',
                actor: 42,
                roomId: 7,
                applicationId: null,
                minSnapshotVersion: '3',
                rallar: { applicationId: 'app-1', minSnapshotVersion: 4 }
            },
            {
                name: 'bob',
                actor: 'bob',
                roomId: 'room-1',
                minSnapshotVersion: null,
                rallar: { applicationId: 'app-1', minSnapshotVersion: 4 }
            }
        ];

        for (const request of requests) {
            await createRallarBlackBoxRtcClient(runtime, request, { commandIdPrefix: 'rallar-bb' }).connect()
                .catch(() => undefined);
        }

        const [alice, bob] = runtimeCommands.mock.calls.map(([command]) => command);
        expect(alice).toMatchObject({ kind: 'rtc.connect', actor: undefined, roomId: undefined, applicationId: 'app-1' });
        expect(alice).not.toHaveProperty('minSnapshotVersion');
        expect(bob).toMatchObject({
            kind: 'rtc.connect',
            actor: 'bob',
            roomId: 'room-1',
            applicationId: 'app-1',
            minSnapshotVersion: 4,
            roomRef: { applicationId: 'app-1', groupId: 'room-1' }
        });
    });

    it('hands a message listener no message and a close listener the event when the event carries no JSON payload', () => {
        const runtime = createRallarBlackBoxTestRuntime();
        const client = createRallarBlackBoxRtcClient(runtime, { name: 'alice' }, { commandIdPrefix: 'rallar-bb' });
        const messages: Array<RallarBlackBoxTestJsonValue | undefined> = [];
        const closes: Array<RallarBlackBoxTestJsonValue | RallarBlackBoxTestEvent> = [];
        client.onMessage?.((message) => messages.push(message));
        client.onClose?.((event) => closes.push(event));

        runtime.recordEvent({ kind: 'message', topic: 'rtc.message', connection: 'alice' });
        runtime.recordEvent({ kind: 'event', topic: 'rtc.close', connection: 'alice' });

        expect(messages).toEqual([undefined]);
        expect(closes).toEqual([expect.objectContaining({ kind: 'event', topic: 'rtc.close', connection: 'alice' })]);
    });

    it('keeps the remote SPA provider mapping aligned with the portable recipe commands', async () => {
        const recipe = createRallarBlackBoxProviderParityRecipe({
            multicastExpectedConnections: ['bobRtc', 'charlieRtc'],
            broadcastExpectedConnections: ['bobRtc', 'charlieRtc']
        });
        const conversion = toRallarBlackBoxRunnerParityInteractions(recipe, {
            provider: 'rallar-remote-browser'
        });
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox([...conversion.interactions], 0, {
            rallarRemoteBrowser: {
                controlBaseUrl: 'http://control.example.test',
                runId: 'run-parity',
                agentId: 'agent-parity',
                timeoutMs: 500,
                pollIntervalMs: 1
            },
            rtcProviders: {
                'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                    fetch: server.fetch
                })
            }
        });

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map((command) => command.kind)).toEqual([
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send',
            'close'
        ]);
        expect(assertCommandById(server.commands, 'parity-connect')).toMatchObject({
            kind: 'rtc.connect',
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'rallar-black-box-room',
            transport: 'realtime',
            metadata: {
                parity: {
                    operation: 'connect'
                }
            }
        });
        expect(assertCommandById(server.commands, 'parity-send-multicast')).toMatchObject({
            kind: 'rtc.send',
            send: assertRtcSendById(recipe.commands, 'parity-send-multicast').send,
            metadata: {
                parity: {
                    operation: 'send.multicast',
                    expectedConnections: ['bobRtc', 'charlieRtc']
                }
            }
        });
        expect(assertCommandById(server.commands, 'parity-close')).toMatchObject({
            kind: 'close',
            metadata: {
                parity: {
                    operation: 'close'
                },
                connection: 'aliceRtc'
            }
        });
    });

    it('normalizes SPA and runner reports while isolating provider-specific fields', () => {
        const runtimeReport = normalizeRallarBlackBoxRuntimeParityReport([
            toResult('parity-connect', 'rtc.connect'),
            toResult('parity-send-direct', 'rtc.send'),
            toResult('parity-close', 'close')
        ]);
        const runnerReport = normalizeBlackBoxRunnerParityReport({
            resultsList: [
                {
                    name: 'parityConnect_connect',
                    status: 'SUCCESS',
                    transport: 'RTC',
                    actual: {
                        commandId: 'parity-connect',
                        provider: 'rallar-remote-browser',
                        remote: {
                            agentId: 'agent-1'
                        }
                    }
                },
                {
                    name: 'paritySendDirect_sendDirect',
                    status: 'SUCCESS',
                    transport: 'RTC',
                    actual: {
                        commandId: 'parity-send-direct',
                        provider: 'rallar-remote-browser'
                    }
                },
                {
                    name: 'parityClose_close',
                    status: 'SUCCESS',
                    transport: 'RTC',
                    actual: {
                        commandId: 'parity-close',
                        provider: 'rallar-remote-browser'
                    }
                }
            ]
        });

        expect(compareRallarBlackBoxProviderParityReports(runtimeReport, runnerReport)).toMatchObject({
            ok: true,
            matchedKeys: [
                'connect:parity-connect',
                'send.direct:parity-send-direct',
                'close:parity-close'
            ]
        });
        expect(runnerReport.providerSpecificFields).toContain('actual');
        expect(runnerReport.steps[0].providerSpecific.actual).toMatchObject({
            provider: 'rallar-remote-browser',
            remote: {
                agentId: 'agent-1'
            }
        });
    });
});
