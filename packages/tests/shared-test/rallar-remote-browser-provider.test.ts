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
                            send: payload,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            connection: 'aliceRtc',
                            withinMs: 500,
                            message: payload,
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
        expect(report.resultsByName.connectAlice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.aliceSendsRemote[0].actual.matchedMessage.data).toEqual(payload);
        expect(report.resultsByName.closeAlice[0].status).toBe('SUCCESS');
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
});
