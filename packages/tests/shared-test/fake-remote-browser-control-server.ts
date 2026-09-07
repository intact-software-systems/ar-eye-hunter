import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestHttpRequestCommand,
    RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/types.ts';

export namespace FakeRemoteBrowserControlServer {
    export type CommandResultValue =
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

    export interface StoredResult {
        readonly kind: 'result';
        readonly runId: string;
        readonly agentId: string;
        readonly commandId: string;
        readonly ok: boolean;
        readonly result: RallarBlackBoxTestResult<CommandResultValue>;
    }

    export interface StoredEvent {
        readonly kind: 'event';
        readonly runId: string;
        readonly agentId: string;
        readonly atEpochMs: number;
        readonly eventId: string;
        readonly commandId: string;
        readonly payload: RallarBlackBoxTestEvent;
    }
}

export class FakeRemoteBrowserControlServer {
    readonly commands: RallarBlackBoxTestCommand[] = [];
    readonly results: FakeRemoteBrowserControlServer.StoredResult[] = [];
    readonly events: FakeRemoteBrowserControlServer.StoredEvent[] = [];

    fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const commandMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/commands$/);
        if (init?.method === 'POST' && commandMatch) {
            const runId = decodeURIComponent(commandMatch[1]);
            const agentId = decodeURIComponent(commandMatch[2]);
            const body: unknown = JSON.parse(String(init.body ?? '{}'));
            if (body === null || typeof body !== 'object' || !('command' in body)) {
                return toJsonResponse({ error: 'Missing command' }, 400);
            }
            const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, body.command);
            if (!validation.ok) {
                return toJsonResponse({ error: validation.errors }, 400);
            }
            this.acceptCommand(runId, agentId, body.command as RallarBlackBoxTestCommand);
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
        const event = toFakeCommandEvent(command, now);
        if (event !== undefined) {
            this.events.push({
                kind: 'event',
                runId,
                agentId,
                atEpochMs: now,
                eventId: event.eventId ?? 'missing-event',
                commandId: command.commandId ?? 'missing-command',
                payload: event
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
                value: toFakeCommandResultValue(command)
            }
        });
    }
}

function toFakeCommandResultValue(command: RallarBlackBoxTestCommand): FakeRemoteBrowserControlServer.CommandResultValue {
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

export function toJsonResponse<T>(value: T, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}

function toFakeCommandEvent(command: RallarBlackBoxTestCommand, now: number): RallarBlackBoxTestEvent | undefined {
    if (command.kind === 'rtc.connect') {
        return {
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
                data: { connected: true }
            }
        };
    }
    if (command.kind === 'rtc.send' || command.kind === 'ws.send') {
        return {
            eventId: `event-${command.commandId}`,
            kind: 'message',
            topic: command.kind === 'ws.send' ? 'rallar.bb.ws.message' : 'rallar.remote.fake.message',
            atEpochMs: now,
            commandId: command.commandId,
            connection: command.connection,
            ...(command.kind === 'ws.send' ? { transport: 'ws' as const } : {}),
            payload: { data: command.kind === 'ws.send' ? command.data : command.send }
        };
    }
    if (command.kind === 'ws.close') {
        return {
            eventId: `event-${command.commandId}`,
            kind: 'event',
            topic: 'rallar.bb.ws.closed',
            atEpochMs: now,
            commandId: command.commandId,
            connection: command.connection,
            transport: 'ws',
            payload: { code: command.code, reason: command.reason, wasClean: true }
        };
    }
    return undefined;
}
