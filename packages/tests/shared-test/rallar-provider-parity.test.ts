import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import {
    compareRallarBlackBoxProviderParityReports,
    createRallarBlackBoxProviderParityRecipe,
    createRallarBlackBoxRtcProvider,
    createRallarBlackBoxTestRuntime,
    normalizeBlackBoxRunnerParityReport,
    normalizeRallarBlackBoxRuntimeParityReport,
    toRallarBlackBoxRunnerParityInteractions,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestEvent,
    type RallarBlackBoxTestResult,
} from '../../shared-test/rallar-bb-test/mod.ts';

type StoredResult = Readonly<{
    kind: 'result';
    runId: string;
    agentId: string;
    commandId: string;
    ok: boolean;
    result: RallarBlackBoxTestResult;
}>;

type StoredEvent = Readonly<{
    kind: 'event';
    runId: string;
    agentId: string;
    atEpochMs: number;
    eventId: string;
    commandId: string;
    payload: RallarBlackBoxTestEvent;
}>;

class FakeRemoteControlServer {
    readonly commands: RallarBlackBoxTestCommand[] = [];
    readonly results: StoredResult[] = [];
    readonly events: StoredEvent[] = [];

    fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const commandMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/commands$/);
        if (init?.method === 'POST' && commandMatch) {
            const runId = decodeURIComponent(commandMatch[1]);
            const agentId = decodeURIComponent(commandMatch[2]);
            const body = JSON.parse(String(init.body ?? '{}')) as {
                command: RallarBlackBoxTestCommand;
            };
            this.acceptCommand(runId, agentId, body.command);
            return jsonResponse({ accepted: true }, 202);
        }

        const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
        if ((!init?.method || init.method === 'GET') && runMatch) {
            return jsonResponse({
                runId: decodeURIComponent(runMatch[1]),
                results: this.results,
                events: this.events,
            });
        }

        return jsonResponse({ error: 'Not found' }, 404);
    };

    private acceptCommand(runId: string, agentId: string, command: RallarBlackBoxTestCommand): void {
        this.commands.push(command);
        const now = 1_000 + this.results.length;
        if (command.kind === 'rtc.send') {
            this.emitSendEvents(runId, agentId, now, command);
        }
        this.results.push({
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
                    command,
                },
            },
        });
    }

    private emitSendEvents(
        runId: string,
        agentId: string,
        now: number,
        command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }>,
    ): void {
        const targets = expectedConnections(command);
        targets.forEach((connection, index) => {
            this.events.push({
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
                        data: command.send,
                    },
                },
            });
        });
    }
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

function expectedConnections(command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }>): readonly string[] {
    const parity = command.metadata?.parity;
    if (
        parity &&
        typeof parity === 'object' &&
        !Array.isArray(parity) &&
        Array.isArray((parity as { expectedConnections?: unknown }).expectedConnections)
    ) {
        return ((parity as { expectedConnections: readonly unknown[] }).expectedConnections)
            .map(String);
    }
    return [command.connection ?? 'default'];
}

function commandById(
    commands: readonly RallarBlackBoxTestCommand[],
    commandId: string,
): RallarBlackBoxTestCommand {
    const command = commands.find(entry => entry.commandId === commandId);
    if (!command) {
        throw new Error(`Missing command ${commandId}`);
    }
    return command;
}

function rtcSendById(
    commands: readonly RallarBlackBoxTestCommand[],
    commandId: string,
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }> {
    const command = commandById(commands, commandId);
    if (command.kind !== 'rtc.send') {
        throw new Error(`Command ${commandId} is not rtc.send`);
    }
    return command;
}

function result(
    commandId: string,
    kind: RallarBlackBoxTestResult['kind'],
    status: RallarBlackBoxTestResult['status'] = 'ok',
): RallarBlackBoxTestResult {
    return {
        commandId,
        kind,
        status,
        ok: status === 'ok',
        startedAtEpochMs: 1,
        endedAtEpochMs: 2,
        durationMs: 1,
    };
}

describe('rallar provider parity helpers', () => {
    it('builds a portable recipe and runner interactions with explicit omissions', () => {
        const recipe = createRallarBlackBoxProviderParityRecipe({
            transport: 'messages.rtc',
            multicastExpectedConnections: ['bobRtc', 'charlieRtc'],
            broadcastExpectedConnections: ['bobRtc', 'charlieRtc'],
        });
        const conversion = toRallarBlackBoxRunnerParityInteractions(recipe, {
            provider: 'rallar-remote-browser',
        });

        expect(recipe.commands.map(command => command.kind)).toEqual([
            'configure',
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send',
            'health',
            'close',
            'reset',
        ]);
        expect(recipe.commands.map(command => command.metadata?.parity)
            .filter(Boolean)
            .map(parity => (parity as { operation: string }).operation))
            .toEqual([
                'configure',
                'connect',
                'send.direct',
                'send.multicast',
                'send.broadcast',
                'health',
                'close',
                'reset',
            ]);
        expect(conversion.omittedCommands.map(command => command.kind)).toEqual([
            'configure',
            'health',
            'reset',
        ]);
        expect(conversion.interactions).toHaveLength(9);
        expect(JSON.stringify(conversion.interactions)).toContain('"action":"wait"');
        expect(JSON.stringify(conversion.interactions)).toContain('"nextHopPeerIds":["bob-session","charlie-session"]');
    });

    it('keeps the facade runner adapter mapping aligned with the SPA command shape', async () => {
        const recipe = createRallarBlackBoxProviderParityRecipe();
        const conversion = toRallarBlackBoxRunnerParityInteractions(recipe, {
            provider: 'rallar-browser',
            includeReceiveWaits: false,
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
                            data: command.send,
                        },
                    });
                }
                if (command.kind === 'close') {
                    context.recordEvent({
                        kind: 'event',
                        topic: 'rallar.bb.parity.closed',
                        commandId: command.commandId,
                        connection: String(command.metadata?.connection ?? 'default'),
                        payload: {
                            closed: true,
                        },
                    });
                }
                return {
                    status: 'ok',
                    value: {
                        command,
                    },
                    nextStatus: context.state().status,
                };
            },
        });

        const report = await executeBlackBox(conversion.interactions, 0, {
            rtcProviders: {
                'rallar-browser': createRallarBlackBoxRtcProvider(runtime),
            },
        });

        expect(report.summary.failure).toBe(0);
        expect(executedCommands.map(command => command.kind)).toEqual([
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send',
            'close',
        ]);
        const recipeConnect = commandById(recipe.commands, 'parity-connect');
        const actualConnect = commandById(executedCommands, 'parity-connect');
        expect(actualConnect).toMatchObject({
            kind: recipeConnect.kind,
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'rallar-black-box-room',
            transport: 'realtime',
        });
        expect(commandById(executedCommands, 'parity-send-direct')).toMatchObject({
            kind: 'rtc.send',
            send: rtcSendById(recipe.commands, 'parity-send-direct').send,
            metadata: {
                parity: {
                    operation: 'send.direct',
                },
            },
        });
        expect(commandById(executedCommands, 'parity-close')).toMatchObject({
            kind: 'close',
            metadata: {
                parity: {
                    operation: 'close',
                },
                connection: 'aliceRtc',
            },
        });
    });

    it('keeps the remote SPA provider mapping aligned with the portable recipe commands', async () => {
        const recipe = createRallarBlackBoxProviderParityRecipe({
            multicastExpectedConnections: ['bobRtc', 'charlieRtc'],
            broadcastExpectedConnections: ['bobRtc', 'charlieRtc'],
        });
        const conversion = toRallarBlackBoxRunnerParityInteractions(recipe, {
            provider: 'rallar-remote-browser',
        });
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox(conversion.interactions, 0, {
            rallarRemoteBrowser: {
                controlBaseUrl: 'http://control.example.test',
                runId: 'run-parity',
                agentId: 'agent-parity',
                timeoutMs: 500,
                pollIntervalMs: 1,
            },
            rtcProviders: {
                'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                    fetch: server.fetch,
                }),
            },
        });

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map(command => command.kind)).toEqual([
            'rtc.connect',
            'rtc.send',
            'rtc.send',
            'rtc.send',
            'close',
        ]);
        expect(commandById(server.commands, 'parity-connect')).toMatchObject({
            kind: 'rtc.connect',
            connection: 'aliceRtc',
            actor: 'alice',
            roomId: 'rallar-black-box-room',
            transport: 'realtime',
            metadata: {
                parity: {
                    operation: 'connect',
                },
            },
        });
        expect(commandById(server.commands, 'parity-send-multicast')).toMatchObject({
            kind: 'rtc.send',
            send: rtcSendById(recipe.commands, 'parity-send-multicast').send,
            metadata: {
                parity: {
                    operation: 'send.multicast',
                    expectedConnections: ['bobRtc', 'charlieRtc'],
                },
            },
        });
        expect(commandById(server.commands, 'parity-close')).toMatchObject({
            kind: 'close',
            metadata: {
                parity: {
                    operation: 'close',
                },
                connection: 'aliceRtc',
            },
        });
    });

    it('normalizes SPA and runner reports while isolating provider-specific fields', () => {
        const runtimeReport = normalizeRallarBlackBoxRuntimeParityReport([
            result('parity-connect', 'rtc.connect'),
            result('parity-send-direct', 'rtc.send'),
            result('parity-close', 'close'),
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
                            agentId: 'agent-1',
                        },
                    },
                },
                {
                    name: 'paritySendDirect_sendDirect',
                    status: 'SUCCESS',
                    transport: 'RTC',
                    actual: {
                        commandId: 'parity-send-direct',
                        provider: 'rallar-remote-browser',
                    },
                },
                {
                    name: 'parityClose_close',
                    status: 'SUCCESS',
                    transport: 'RTC',
                    actual: {
                        commandId: 'parity-close',
                        provider: 'rallar-remote-browser',
                    },
                },
            ],
        });

        expect(compareRallarBlackBoxProviderParityReports(runtimeReport, runnerReport)).toMatchObject({
            ok: true,
            matchedKeys: [
                'connect:parity-connect',
                'send.direct:parity-send-direct',
                'close:parity-close',
            ],
        });
        expect(runnerReport.providerSpecificFields).toContain('actual');
        expect(runnerReport.steps[0].providerSpecific.actual).toMatchObject({
            provider: 'rallar-remote-browser',
            remote: {
                agentId: 'agent-1',
            },
        });
    });
});
