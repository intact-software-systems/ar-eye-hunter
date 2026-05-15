import {
    type ControlCommandEnvelope,
    parseControlClientMessage,
    validateRallarBlackBoxTestCommand,
} from '../../rallar-black-box/src/control-protocol.ts';
import type { EnqueueControlCommandInput } from './control-service.ts';
import { createRallarBlackBoxControlService } from './control-service.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandKind,
} from '@shared-test/rallar-bb-test/types.ts';

const DEFAULT_PORT = 5180;
const OPEN_STATE = 1;

type SecurityOptions = Readonly<{
    allowedOrigins: readonly string[];
    requireTls: boolean;
    requireRunToken: boolean;
    adminToken?: string;
    runTokenTtlMs: number;
    maxRequestBytes: number;
    allowedCommandKinds?: readonly RallarBlackBoxTestCommandKind[];
    commandRateLimitMax: number;
    commandRateLimitWindowMs: number;
    httpAllowedHosts: readonly string[];
    httpAllowedOrigins: readonly string[];
    wsAllowedHosts: readonly string[];
    wsAllowedOrigins: readonly string[];
}>;

const security = resolveSecurityOptions();
const controlService = createRallarBlackBoxControlService({
    allowedCommandKinds: security.allowedCommandKinds,
    commandRateLimitMax: security.commandRateLimitMax,
    commandRateLimitWindowMs: security.commandRateLimitWindowMs,
    runTokenTtlMs: security.runTokenTtlMs,
});
const agentSockets = new Map<string, WebSocket>();
const socketAgents = new WeakMap<WebSocket, { runId: string; agentId: string }>();

const port = Number(Deno.env.get('PORT') ?? DEFAULT_PORT);

Deno.serve({ port }, async (request) => {
    const url = new URL(request.url);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const policyRejection = rejectByRequestPolicy(request, url);
    if (policyRejection) {
        return policyRejection;
    }

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
        if (!authorizeRunRequest(request, url, runId, agentId)) {
            return jsonResponse({ error: 'Run token is required or invalid.' }, 401);
        }
        return await enqueueCommand(request, runId, agentId);
    }

    const agentReportMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/report$/);
    if (request.method === 'POST' && agentReportMatch) {
        const runId = decodeURIComponent(agentReportMatch[1]);
        const agentId = decodeURIComponent(agentReportMatch[2]);
        if (!authorizeRunRequest(request, url, runId, agentId)) {
            return jsonResponse({ error: 'Run token is required or invalid.' }, 401);
        }
        return await uploadReport(request, runId, agentId);
    }

    const agentTokenMatch = url.pathname.match(/^\/runs\/([^/]+)\/agents\/([^/]+)\/tokens$/);
    if (request.method === 'POST' && agentTokenMatch) {
        const runId = decodeURIComponent(agentTokenMatch[1]);
        const agentId = decodeURIComponent(agentTokenMatch[2]);
        if (!authorizeAdminRequest(request, url)) {
            return jsonResponse({ error: 'Admin token is required or invalid.' }, 401);
        }
        return await issueRunToken(request, runId, agentId);
    }

    return jsonResponse({ error: 'Not found.' }, 404);
});

console.log(`Rallar black-box control server listening on http://localhost:${port}`);
console.log(`Agent WebSocket endpoint: ws://localhost:${port}/control`);

function handleControlSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'Expected WebSocket upgrade.' }, 426);
    }

    const url = new URL(request.url);
    const socketToken = tokenFromRequest(request, url);
    const { socket, response } = Deno.upgradeWebSocket(request);

    socket.onmessage = (event) => {
        const parsed = parseControlClientMessage(event.data);
        if (!parsed.ok) {
            socket.close(1003, parsed.error);
            return;
        }

        if (
            parsed.envelope.kind === 'register' &&
            !authorizeRunToken(
                parsed.envelope.runId,
                parsed.envelope.agentId,
                parsed.envelope.token ?? socketToken,
            )
        ) {
            socket.close(1008, 'Run token is required or invalid.');
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
        body = await readJsonBody(request) as Omit<EnqueueControlCommandInput, 'runId' | 'agentId'>;
    } catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }

    if (!body || typeof body !== 'object' || !('command' in body)) {
        return jsonResponse({ error: 'Command request requires command.' }, 400);
    }

    const validation = validateRallarBlackBoxTestCommand(body.command);
    if (!validation.ok) {
        return jsonResponse({ error: validation.error }, 400);
    }

    const destinationError = validateBrowserCommandDestination(body.command);
    if (destinationError) {
        return jsonResponse({ error: destinationError }, 403);
    }

    let envelope: ControlCommandEnvelope;
    try {
        envelope = controlService.enqueueCommand({
            runId,
            agentId,
            commandId: body.commandId,
            command: body.command,
            deadlineEpochMs: body.deadlineEpochMs,
        });
    } catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
        }, error instanceof Error && error.message.includes('rate limit') ? 429 : 400);
    }
    sendDispatchableCommands(runId, agentId);
    return jsonResponse({
        accepted: true,
        command: envelope,
    }, 202);
}

async function uploadReport(
    request: Request,
    runId: string,
    agentId: string,
): Promise<Response> {
    let body: unknown;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }

    const parsed = parseControlClientMessage(body);
    if (!parsed.ok) {
        return jsonResponse({
            error: parsed.error,
        }, 400);
    }

    if (
        parsed.envelope.kind !== 'report' ||
        parsed.envelope.runId !== runId ||
        parsed.envelope.agentId !== agentId
    ) {
        return jsonResponse({
            error: 'Report upload envelope does not match the target run and agent.',
        }, 400);
    }

    controlService.receiveClientEnvelope(parsed.envelope);
    return jsonResponse({
        accepted: true,
    }, 202);
}

async function issueRunToken(
    request: Request,
    runId: string,
    agentId: string,
): Promise<Response> {
    let body: unknown = {};
    try {
        body = await readJsonBody(request, true);
    } catch (error) {
        return jsonResponse({
            error: error instanceof Error ? error.message : String(error),
        }, 400);
    }

    const ttlMs = body && typeof body === 'object' && 'ttlMs' in body
        ? Number.parseInt(String((body as { ttlMs?: unknown }).ttlMs), 10)
        : undefined;
    const effectiveTtlMs = ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0
        ? ttlMs
        : security.runTokenTtlMs;
    const token = controlService.issueRunToken({
        runId,
        agentId,
        ttlMs: effectiveTtlMs,
    });

    return jsonResponse(token, 201);
}

function resolveSecurityOptions(): SecurityOptions {
    const allowedCommandKinds = envList('RALLAR_BLACK_BOX_ALLOWED_COMMANDS');
    return {
        allowedOrigins: envList('RALLAR_BLACK_BOX_ALLOWED_ORIGINS'),
        requireTls: envBoolean('RALLAR_BLACK_BOX_REQUIRE_TLS'),
        requireRunToken: envBoolean('RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN'),
        adminToken: envString('RALLAR_BLACK_BOX_ADMIN_TOKEN'),
        runTokenTtlMs: envNumber('RALLAR_BLACK_BOX_RUN_TOKEN_TTL_MS', 15 * 60_000),
        maxRequestBytes: envNumber('RALLAR_BLACK_BOX_MAX_REQUEST_BYTES', 2_000_000),
        allowedCommandKinds: allowedCommandKinds.length > 0
            ? allowedCommandKinds as RallarBlackBoxTestCommandKind[]
            : undefined,
        commandRateLimitMax: envNumber('RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_MAX', 120),
        commandRateLimitWindowMs: envNumber('RALLAR_BLACK_BOX_COMMAND_RATE_LIMIT_WINDOW_MS', 60_000),
        httpAllowedHosts: envList('RALLAR_BLACK_BOX_HTTP_ALLOWED_HOSTS'),
        httpAllowedOrigins: envList('RALLAR_BLACK_BOX_HTTP_ALLOWED_ORIGINS'),
        wsAllowedHosts: envList('RALLAR_BLACK_BOX_WS_ALLOWED_HOSTS'),
        wsAllowedOrigins: envList('RALLAR_BLACK_BOX_WS_ALLOWED_ORIGINS'),
    };
}

function envString(key: string): string | undefined {
    const value = Deno.env.get(key)?.trim();
    return value && value.length > 0 ? value : undefined;
}

function envList(key: string): string[] {
    return (Deno.env.get(key) ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(value => value.length > 0);
}

function envNumber(key: string, fallback: number): number {
    const parsed = Number.parseInt(Deno.env.get(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBoolean(key: string): boolean {
    const normalized = (Deno.env.get(key) ?? '').trim().toLowerCase();
    return normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on';
}

function rejectByRequestPolicy(request: Request, url: URL): Response | undefined {
    if (
        security.requireTls &&
        url.protocol !== 'https:' &&
        request.headers.get('x-forwarded-proto') !== 'https'
    ) {
        return jsonResponse({ error: 'TLS is required.' }, 400);
    }

    const origin = request.headers.get('origin');
    if (
        origin &&
        security.allowedOrigins.length > 0 &&
        !security.allowedOrigins.includes(origin)
    ) {
        return jsonResponse({ error: 'Origin is not allowed.' }, 403);
    }

    return undefined;
}

function authorizeAdminRequest(request: Request, url: URL): boolean {
    return !security.adminToken || tokenFromRequest(request, url) === security.adminToken;
}

function authorizeRunRequest(
    request: Request,
    url: URL,
    runId: string,
    agentId: string,
): boolean {
    return authorizeRunToken(runId, agentId, tokenFromRequest(request, url));
}

function authorizeRunToken(runId: string, agentId: string, token: string | undefined): boolean {
    const tokenRequired = security.requireRunToken || controlService.hasActiveRunToken(runId, agentId);
    if (!tokenRequired) {
        return true;
    }

    return controlService.validateRunToken(runId, agentId, token);
}

function tokenFromRequest(request: Request, url: URL): string | undefined {
    const authorization = request.headers.get('authorization');
    if (authorization?.toLowerCase().startsWith('bearer ')) {
        return authorization.slice('bearer '.length).trim();
    }

    return request.headers.get('x-rallar-run-token')?.trim() ||
        url.searchParams.get('token')?.trim() ||
        undefined;
}

async function readJsonBody(request: Request, allowEmpty = false): Promise<unknown> {
    const text = await request.text();
    if (text.length === 0 && allowEmpty) {
        return {};
    }

    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > security.maxRequestBytes) {
        throw new Error(
            `Request payload is too large: ${byteLength} bytes exceeds ${security.maxRequestBytes} bytes.`,
        );
    }

    return JSON.parse(text);
}

function validateBrowserCommandDestination(command: RallarBlackBoxTestCommand): string | undefined {
    if (command.kind === 'http.request') {
        return validateDestination(
            command.request.url ?? command.request.path,
            security.httpAllowedOrigins,
            security.httpAllowedHosts,
            'HTTP',
        );
    }

    if (command.kind === 'ws.open') {
        return validateDestination(
            command.url,
            security.wsAllowedOrigins,
            security.wsAllowedHosts,
            'WebSocket',
        );
    }

    return undefined;
}

function validateDestination(
    value: string | undefined,
    allowedOrigins: readonly string[],
    allowedHosts: readonly string[],
    label: string,
): string | undefined {
    if (!value || (allowedOrigins.length === 0 && allowedHosts.length === 0)) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch (_error) {
        return undefined;
    }

    if (allowedOrigins.includes(parsed.origin)) {
        return undefined;
    }

    if (allowedHosts.some(allowedHost => hostMatches(parsed.host, parsed.hostname, allowedHost))) {
        return undefined;
    }

    return `${label} destination is not allowed: ${parsed.origin}`;
}

function hostMatches(host: string, hostname: string, allowedHost: string): boolean {
    if (allowedHost === host || allowedHost === hostname) {
        return true;
    }
    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
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
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Rallar-Run-Token',
    });
    if (contentType) {
        headers.set('Content-Type', contentType);
    }
    return headers;
}
