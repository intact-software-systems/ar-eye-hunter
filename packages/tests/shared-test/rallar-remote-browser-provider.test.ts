import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';
import type { RallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/types.ts';

type StoredResult = Readonly<{
    kind: 'result';
    runId: string;
    agentId: string;
    commandId: string;
    ok: boolean;
    result: Readonly<{
        commandId: string;
        kind: string;
        status: 'ok';
        ok: true;
        startedAtEpochMs: number;
        endedAtEpochMs: number;
        durationMs: number;
        value: unknown;
    }>;
}>;

type StoredEvent = Readonly<{
    kind: 'event';
    runId: string;
    agentId: string;
    atEpochMs: number;
    eventId: string;
    commandId: string;
    payload: unknown;
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
            return jsonResponse({
                accepted: true,
            }, 202);
        }

        const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
        if ((!init?.method || init.method === 'GET') && runMatch) {
            return jsonResponse({
                runId: decodeURIComponent(runMatch[1]),
                results: this.results,
                events: this.events,
            });
        }

        return jsonResponse({
            error: 'Not found',
        }, 404);
    };

    private acceptCommand(
        runId: string,
        agentId: string,
        command: RallarBlackBoxTestCommand,
    ): void {
        this.commands.push(command);
        const now = 1_000 + this.results.length;
        if (command.kind === 'rtc.connect') {
            this.events.push({
                kind: 'event',
                runId,
                agentId,
                atEpochMs: now,
                eventId: `event-${command.commandId}-connected`,
                commandId: command.commandId ?? 'missing-command',
                payload: {
                    eventId: `event-${command.commandId}-connected`,
                    kind: 'diagnostic',
                    topic: 'rallar.bb.rtc.connected',
                    atEpochMs: now,
                    commandId: command.commandId,
                    connection: command.connection,
                    actor: command.actor,
                    transport: command.transport,
                    payload: {
                        roomId: command.roomId,
                        roomRef: command.roomRef,
                        applicationId: command.applicationId,
                        workspaceId: command.workspaceId,
                        data: {
                            connected: true,
                        },
                    },
                },
            });
        }

        if (command.kind === 'rtc.send') {
            this.events.push({
                kind: 'event',
                runId,
                agentId,
                atEpochMs: now,
                eventId: `event-${command.commandId}`,
                commandId: command.commandId ?? 'missing-command',
                payload: {
                    eventId: `event-${command.commandId}`,
                    kind: 'message',
                    topic: 'rallar.remote.fake.message',
                    atEpochMs: now,
                    commandId: command.commandId,
                    connection: command.connection,
                    payload: {
                        data: command.send,
                    },
                },
            });
        }

        if (command.kind === 'ws.send') {
            this.events.push({
                kind: 'event',
                runId,
                agentId,
                atEpochMs: now,
                eventId: `event-${command.commandId}`,
                commandId: command.commandId ?? 'missing-command',
                payload: {
                    eventId: `event-${command.commandId}`,
                    kind: 'message',
                    topic: 'rallar.bb.ws.message',
                    atEpochMs: now,
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: 'ws',
                    payload: {
                        data: command.data,
                    },
                },
            });
        }

        if (command.kind === 'ws.close') {
            this.events.push({
                kind: 'event',
                runId,
                agentId,
                atEpochMs: now,
                eventId: `event-${command.commandId}`,
                commandId: command.commandId ?? 'missing-command',
                payload: {
                    eventId: `event-${command.commandId}`,
                    kind: 'event',
                    topic: 'rallar.bb.ws.closed',
                    atEpochMs: now,
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: 'ws',
                    payload: {
                        code: command.code,
                        reason: command.reason,
                        wasClean: true,
                    },
                },
            });
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
                value: this.resultValue(command),
            },
        });
    }

    private resultValue(command: RallarBlackBoxTestCommand): unknown {
        if (command.kind === 'http.request') {
            return {
                url: command.request.url ?? command.request.path,
                status: 201,
                statusText: 'Created',
                ok: true,
                headers: {
                    'content-type': 'application/json',
                },
                body: {
                    ok: true,
                    method: command.request.method,
                    body: command.request.body,
                },
            };
        }

        if (command.kind === 'health') {
            return {
                rallar: {
                    connected: true,
                    laneHealth: {
                        ready: true,
                    },
                },
            };
        }

        return {
            accepted: true,
            command,
        };
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

describe('rallar remote browser RTC provider', () => {
    it('is registered as a default black-box runner RTC provider', async () => {
        const report = await executeBlackBox([]);

        expect(report.rtcProviderNames).toContain('rallar-remote-browser');
    });

    it('sends runner RTC interactions through the control server and consumes remote events', async () => {
        const server = new FakeRemoteControlServer();
        const roomRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: 'room-1',
        };
        const payload = {
            topic: 'chat.message',
            payload: {
                text: 'hello remote browser',
            },
        };

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            roomId: 'room-1',
                            roomRef,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
                {
                    RTC: {
                        request: {
                            action: 'send',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            roomId: 'room-1',
                            roomRef,
                            minSnapshotVersion: 11,
                            send: payload,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            connection: 'aliceRtc',
                            withinMs: 500,
                            message: {
                                kind: 'message',
                                topic: 'rallar.remote.fake.message',
                                data: {
                                    ...payload,
                                    roomRef,
                                    minSnapshotVersion: 11,
                                },
                            },
                        },
                    },
                    aliceSendsRemote: {},
                },
                {
                    RTC: {
                        request: {
                            action: 'close',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            roomId: 'room-1',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3,
                        },
                        response: {},
                    },
                    closeAlice: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch,
                    }),
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map(command => command.kind)).toEqual([
            'rtc.connect',
            'rtc.send',
            'close',
        ]);
        expect(server.commands[0]).toMatchObject({
            kind: 'rtc.connect',
            roomRef,
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
            },
        });
        expect(server.commands[1]).toMatchObject({
            kind: 'rtc.send',
            roomRef,
            minSnapshotVersion: 11,
            send: {
                ...payload,
                roomRef,
                minSnapshotVersion: 11,
            },
        });
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.aliceSendsRemote[0].actual.matchedMessage.data)
            .toMatchObject({
                kind: 'message',
                topic: 'rallar.remote.fake.message',
                data: {
                    ...payload,
                    roomRef,
                    minSnapshotVersion: 11,
                },
            });
        expect(report.resultsByName.aliceSendsRemote[0].actual.sendResult.status).toBe('sent');
        expect(typeof report.resultsByName.aliceSendsRemote[0].actual.sendLatencyMs).toBe('number');
        expect(report.rtcDiagnostics.aliceRtc[0]).toMatchObject({
            topic: 'rallar.bb.rtc.connected',
            data: {
                connected: true,
            },
        });
        expect(report.resultsByName.closeAlice[0].status).toBe('SUCCESS');
    });

    it('waits for remote RTC diagnostics and health through generic expectations', async () => {
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            roomId: 'room-1',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
                {
                    RTC: {
                        request: {
                            action: 'wait',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            withinMs: 500,
                            diagnostic: {
                                topic: 'rallar.bb.rtc.connected',
                                data: {
                                    connected: true,
                                },
                            },
                        },
                    },
                    waitForRemoteDiagnostic: {},
                },
                {
                    RTC: {
                        request: {
                            action: 'wait',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3,
                        },
                        response: {
                            withinMs: 500,
                            health: {
                                rallar: {
                                    connected: true,
                                    laneHealth: {
                                        ready: true,
                                    },
                                },
                            },
                        },
                    },
                    waitForRemoteHealth: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-health',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch,
                    }),
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.waitForRemoteDiagnostic[0].actual.matchedDiagnostic.topic)
            .toBe('rallar.bb.rtc.connected');
        expect(report.resultsByName.waitForRemoteHealth[0].actual.matchedHealth)
            .toMatchObject({
                rallar: {
                    connected: true,
                    laneHealth: {
                        ready: true,
                    },
                },
            });
        expect(server.commands.map(command => command.kind)).toContain('health');
    });

    it('reports a clear failure when the control server does not return a command result', async () => {
        const fetchWithoutResults = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (init?.method === 'POST') {
                return jsonResponse({
                    accepted: true,
                }, 202);
            }
            return jsonResponse({
                runId: url.pathname.split('/').at(-1),
                results: [],
                events: [],
            });
        };

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-timeout',
                    agentId: 'agent-remote',
                    timeoutMs: 20,
                    pollIntervalMs: 1,
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: fetchWithoutResults,
                    }),
                },
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.connectAlice[0].result).toBe('Remote RTC connect failed');
        expect(report.resultsByName.connectAlice[0].actual.exception).toContain(
            'Timed out waiting for remote command result',
        );
    });

    it('auto-closes remote connections through the control server', async () => {
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox(
            [
                {
                    RTC: {
                        request: {
                            action: 'connect',
                            connection: 'aliceRtc',
                            provider: 'rallar-remote-browser',
                            actor: 'alice',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    connectAlice: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-auto-close',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                },
                rtcProviders: {
                    'rallar-remote-browser': createRallarRemoteBrowserRtcProvider({
                        fetch: server.fetch,
                    }),
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map(command => command.kind)).toEqual([
            'rtc.connect',
            'close',
        ]);
        expect(report.rtcCloseEvents.aliceRtc[0].autoCloseRequested).toBe(true);
    });

    it('routes remote HTTP interactions through the control server', async () => {
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox(
            [
                {
                    HTTP: {
                        request: {
                            provider: 'rallar-remote-browser',
                            path: 'https://api.example.test/widgets',
                            method: 'POST',
                            body: {
                                name: 'remote-widget',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {
                            statusCode: 201,
                            body: {
                                ok: true,
                                method: 'POST',
                                body: {
                                    name: 'remote-widget',
                                },
                            },
                        },
                    },
                    createRemoteWidget: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-http',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch,
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map(command => command.kind)).toEqual([
            'http.request',
        ]);
        const command = server.commands[0];
        expect(command.kind).toBe('http.request');
        if (command.kind === 'http.request') {
            expect(command.request.path).toBe('https://api.example.test/widgets');
            expect(command.request.body).toEqual({
                name: 'remote-widget',
            });
        }
        expect(report.resultsByName.createRemoteWidget[0].actual.statusCode).toBe(201);
        expect(report.resultsByName.createRemoteWidget[0].actual.commandId).toContain('rallar-remote-browser-http');
        expect(report.resultsByName.createRemoteWidget[0].actual.result).toMatchObject({
            status: 201,
            body: {
                ok: true,
            },
        });
    });

    it('blocks remote HTTP destinations outside the configured allowlist', async () => {
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox(
            [
                {
                    HTTP: {
                        request: {
                            provider: 'rallar-remote-browser',
                            path: 'https://blocked.example.test/widgets',
                            method: 'GET',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    blockedRemoteHttp: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-http-blocked',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch,
                    allowedHosts: ['api.example.test'],
                },
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(server.commands).toEqual([]);
        expect(report.resultsByName.blockedRemoteHttp[0].exception).toContain('destination is not allowed');
    });

    it('blocks remote WebSocket sends above the configured payload limit', async () => {
        const server = new FakeRemoteControlServer();

        const report = await executeBlackBox(
            [
                {
                    WS: {
                        request: {
                            action: 'connect',
                            connection: 'controlWs',
                            provider: 'rallar-remote-browser',
                            path: 'wss://ws.example.test/control',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    openLimitedRemoteWs: {},
                },
                {
                    WS: {
                        request: {
                            action: 'send',
                            connection: 'controlWs',
                            send: 'payload-too-large',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    sendTooLargeRemoteWs: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-ws-limited',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch,
                    maxPayloadBytes: 4,
                },
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(server.commands.map(command => command.kind)).toContain('ws.open');
        expect(server.commands.map(command => command.kind)).not.toContain('ws.send');
        expect(report.resultsByName.sendTooLargeRemoteWs[0].result).toBe('Remote WebSocket send failed');
        expect(report.resultsByName.sendTooLargeRemoteWs[0].actual.exception).toContain('payload is too large');
    });

    it('routes remote WebSocket interactions through the control server', async () => {
        const server = new FakeRemoteControlServer();
        const payload = {
            topic: 'presence.ping',
            payload: {
                id: 'ping-1',
            },
        };

        const report = await executeBlackBox(
            [
                {
                    WS: {
                        request: {
                            action: 'connect',
                            connection: 'controlWs',
                            provider: 'rallar-remote-browser',
                            path: 'wss://ws.example.test/control',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    openRemoteWs: {},
                },
                {
                    WS: {
                        request: {
                            action: 'send',
                            connection: 'controlWs',
                            send: payload,
                            output: 'wsEchoTopic',
                            outputPath: 'matchedMessage.data.topic',
                            outputs: {
                                wsPayloadId: 'matchedMessage.data.payload.id',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            connection: 'controlWs',
                            withinMs: 500,
                            message: payload,
                        },
                    },
                    sendRemoteWs: {},
                },
                {
                    WS: {
                        request: {
                            action: 'close',
                            connection: 'controlWs',
                            code: 1000,
                            reason: 'done',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 3,
                        },
                        response: {},
                    },
                    closeRemoteWs: {},
                },
            ],
            0,
            {
                rallarRemoteBrowser: {
                    controlBaseUrl: 'http://control.example.test',
                    runId: 'run-remote-ws',
                    agentId: 'agent-remote',
                    timeoutMs: 500,
                    pollIntervalMs: 1,
                    fetch: server.fetch,
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(server.commands.map(command => command.kind)).toEqual([
            'ws.open',
            'ws.send',
            'ws.close',
        ]);
        expect(report.resultsByName.openRemoteWs[0].status).toBe('SUCCESS');
        expect(report.resultsByName.sendRemoteWs[0].actual.matchedMessage.data).toEqual(payload);
        expect(report.outputs.wsEchoTopic).toBe('presence.ping');
        expect(report.outputs.wsPayloadId).toBe('ping-1');
        expect(report.resultsByName.closeRemoteWs[0].status).toBe('SUCCESS');
        expect(report.wsCloseEvents.controlWs[0].code).toBe(1000);
    });
});
