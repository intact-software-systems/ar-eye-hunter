import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/types.ts';

/** The three canned values this fake answers commands with. */
type FakeCommandResultValue =
    | Readonly<{
        url: string | undefined;
        status: number;
        statusText: string;
        ok: true;
        headers: Readonly<Record<string, string>>;
        body: Readonly<{
            ok: true;
            method: string | undefined;
            body: RallarBlackBoxTestHttpRequestCommand['request']['body'];
        }>;
    }>
    | Readonly<{
        rallar: Readonly<{
            connected: true;
            laneHealth: Readonly<{ ready: true; }>;
        }>;
    }>
    | Readonly<{ accepted: true; command: RallarBlackBoxTestCommand; }>;

type StoredResult = Readonly<{
    kind: 'result';
    runId: string;
    agentId: string;
    commandId: string;
    ok: boolean;
    result: RallarBlackBoxTestResult<FakeCommandResultValue>;
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

export class FakeRemoteBrowserControlServer {
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
            return toJsonResponse({
                accepted: true
            }, 202);
        }

        const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
        if ((!init?.method || init.method === 'GET') && runMatch) {
            return toJsonResponse({
                runId: decodeURIComponent(runMatch[1]),
                results: this.results,
                events: this.events
            });
        }

        return toJsonResponse({
            error: 'Not found'
        }, 404);
    };

    private acceptCommand(
        runId: string,
        agentId: string,
        command: RallarBlackBoxTestCommand
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
                            connected: true
                        }
                    }
                }
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
                        data: command.send
                    }
                }
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
                        data: command.data
                    }
                }
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
                        wasClean: true
                    }
                }
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
                value: this.resultValue(command)
            }
        });
    }

    private resultValue(command: RallarBlackBoxTestCommand): FakeCommandResultValue {
        if (command.kind === 'http.request') {
            return {
                url: command.request.url ?? command.request.path,
                status: 201,
                statusText: 'Created',
                ok: true,
                headers: {
                    'content-type': 'application/json'
                },
                body: {
                    ok: true,
                    method: command.request.method,
                    body: command.request.body
                }
            };
        }

        if (command.kind === 'health') {
            return {
                rallar: {
                    connected: true,
                    laneHealth: {
                        ready: true
                    }
                }
            };
        }

        return {
            accepted: true,
            command
        };
    }
}

export function toJsonResponse<T>(value: T, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}
