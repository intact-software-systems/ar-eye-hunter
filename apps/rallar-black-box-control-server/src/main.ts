import {
    type ControlCommandEnvelope,
    parseControlClientMessage,
} from '../../rallar-black-box/src/control-protocol.ts';
import type { EnqueueControlCommandInput } from './control-service.ts';
import { createRallarBlackBoxControlService } from './control-service.ts';

const DEFAULT_PORT = 5180;
const OPEN_STATE = 1;

const controlService = createRallarBlackBoxControlService();
const agentSockets = new Map<string, WebSocket>();
const socketAgents = new WeakMap<WebSocket, { runId: string; agentId: string }>();

const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);

Deno.serve({ port }, async (request) => {
    const url = new URL(request.url);
    const isRead = request.method === 'GET' || request.method === 'HEAD';

    if (request.method === 'OPTIONS') {
        return emptyResponse(204);
    }

    if (url.pathname === '/control') {
        return handleControlSocket(request);
    }

    if (isRead && url.pathname === '/health') {
        return jsonResponse({
            ok: true,
            app: 'rallar-black-box-control-server',
            protocolVersion: 1,
        });
    }

    if (isRead && url.pathname === '/runs') {
        return jsonResponse(controlService.snapshot());
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (isRead && runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const run = controlService.snapshotRun(runId);
        return run ? jsonResponse(run) : jsonResponse({ error: 'Run not found.' }, 404);
    }

    const agentCommandMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/commands$/);
    if (request.method === 'POST' && agentCommandMatch) {
        const runId = decodeURIComponent(agentCommandMatch[1]);
        const agentId = decodeURIComponent(agentCommandMatch[2]);
        return await enqueueCommand(request, runId, agentId);
    }

    return jsonResponse({ error: 'Not found.' }, 404);
});

console.log(`Rallar black-box control server listening on http://localhost:${port}`);
console.log(`Agent WebSocket endpoint: ws://localhost:${port}/control`);

function handleControlSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'Expected WebSocket upgrade.' }, 426);
    }

    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.onmessage = (event) => {
        const parsed = parseControlClientMessage(event.data);
        if (!parsed.ok) {
            socket.close(1003, parsed.error);
            return;
        }

        const received = controlService.receiveClientEnvelope(parsed.envelope);
        if (received.kind === 'register') {
            registerSocket(socket, received.runId, received.agentId);
            sendDispatchableCommands(received.runId, received.agentId);
        }
    };

    socket.onclose = () => {
        const agent = socketAgents.get(socket);
        if (!agent) {
            return;
        }

        const key = agentKey(agent.runId, agent.agentId);
        if (agentSockets.get(key) === socket) {
            agentSockets.delete(key);
            controlService.markAgentDisconnected(agent.runId, agent.agentId);
        }
    };

    return response;
}

async function enqueueCommand(
    request: Request,
    runId: string,
    agentId: string,
): Promise<Response> {
    let body: Omit<EnqueueControlCommandInput, 'runId' | 'agentId'>;
    try {
        body = await request.json();
    } catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }

    if (!body || typeof body !== 'object' || !('command' in body)) {
        return jsonResponse({ error: 'Command request requires command.' }, 400);
    }

    const envelope = controlService.enqueueCommand({
        runId,
        agentId,
        commandId: body.commandId,
        command: body.command,
        deadlineEpochMs: body.deadlineEpochMs,
    });
    sendDispatchableCommands(runId, agentId);
    return jsonResponse({
        accepted: true,
        command: envelope,
    }, 202);
}

function registerSocket(socket: WebSocket, runId: string, agentId: string): void {
    const key = agentKey(runId, agentId);
    const existing = agentSockets.get(key);
    if (existing && existing !== socket) {
        existing.close(4000, 'agent re-registered');
    }

    socketAgents.set(socket, { runId, agentId });
    agentSockets.set(key, socket);
}

function sendDispatchableCommands(runId: string, agentId: string): void {
    const socket = agentSockets.get(agentKey(runId, agentId));
    if (!socket || socket.readyState !== OPEN_STATE) {
        return;
    }

    const commands = controlService.takeDispatchableCommands(runId, agentId);
    for (const command of commands) {
        sendCommand(socket, command);
    }
}

function sendCommand(socket: WebSocket, command: ControlCommandEnvelope): void {
    socket.send(JSON.stringify(command));
}

function agentKey(runId: string, agentId: string): string {
    return `${runId}\u0000${agentId}`;
}

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value, null, 2), {
        status,
        headers: responseHeaders('application/json'),
    });
}

function emptyResponse(status: number): Response {
    return new Response(null, {
        status,
        headers: responseHeaders(),
    });
}

function responseHeaders(contentType?: string): Headers {
    const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    if (contentType) {
        headers.set('Content-Type', contentType);
    }
    return headers;
}
