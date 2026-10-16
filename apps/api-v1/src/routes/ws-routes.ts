import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import { type RegisterAuthorisedWsClientInput } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type {
    AppClientInboxService
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
    toAuthorisedWsClientConnection,
    type ToAuthorisedWsClientConnectEnqueueInput,
    type ToAuthorisedWsClientDisconnectEnqueueInput
} from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import type { AuthorisedWsClientMutationResult } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import { type GroupPresenceSessionCleanupAppInboxPayload } from '@shared-server/rallar-system/group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts';
import type { RallarWsLifecycleCloseInput } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';
import {
    readAuthorisedWsConnection,
    rememberAuthorisedWsConnection
} from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { RequestAuthFailure, toAuthErrorResponse } from '../services/request-auth-service.ts';

export interface RegisterWsRoutesInput {
    readonly socketServer: JsonWebSocketServer;
    readonly appClientInboxService: Pick<
        AppClientInboxService,
        'writeAuthorisedWsClientConnect' | 'enqueueAuthorisedWsClientDisconnect'
    >;
    readonly readWsConnectSession: (sessionId: string) => Promise<PersistedAuthSession | undefined>;
    readonly upgradeWebSocket: (request: Request) => Deno.WebSocketUpgrade;
    readonly nowEpochMs: () => number;
}

interface AuthorisedWsConnect {
    readonly enqueue: ToAuthorisedWsClientConnectEnqueueInput;
    readonly generation: JsonWebSocketServer.ConnectionGeneration;
    readonly expected: JsonWebSocketServer.ExpectedConnection;
}

export function registerWsRoutes(app: Hono, input: RegisterWsRoutesInput): void {
    app.get(
        '/api/ws/:sessionId',
        (context) => upgradeAuthorisedWebSocket(context, input)
    );
}

/** The ticket is consumed by the connect's own transaction; the socket upgrades and registers only after it commits. */
async function upgradeAuthorisedWebSocket(
    context: Context,
    input: RegisterWsRoutesInput
): Promise<Response> {
    if (!isWebSocketUpgradeHeader(context.req.header('upgrade'))) {
        return context.text('Expected Upgrade: websocket', 426);
    }
    const sessionId = context.req.param('sessionId');
    const requestUrl = new URL(context.req.url);
    const ticket = requestUrl.searchParams.get('ticket');
    const session = ticket ? await input.readWsConnectSession(sessionId) : undefined;
    if (!ticket || session?.sessionId !== sessionId) {
        return toWsTicketRejectionResponse(context, { sessionId, generationId: null });
    }
    const connect = await toAuthorisedWsConnect(input, {
        session,
        ticket,
        requestUrl,
        userAgent: context.req.header('user-agent')
    });
    input.socketServer.expectConnection(connect.expected);
    const written = await writeAuthorisedWsConnect(input, connect);
    if (written?.right?.status === 'ok') {
        return await registerAuthorisedWebSocket(context, input, connect);
    }
    input.socketServer.releaseExpectedConnection(connect.expected);
    return await toUnwrittenConnectResponse(context, input, { connect, written });
}

interface ToAuthorisedWsConnectInput {
    readonly session: PersistedAuthSession;
    readonly ticket: string;
    readonly requestUrl: URL;
    readonly userAgent: string | undefined;
}

async function toAuthorisedWsConnect(
    input: RegisterWsRoutesInput,
    request: ToAuthorisedWsConnectInput
): Promise<AuthorisedWsConnect> {
    const generation = input.socketServer.mintConnectionGeneration({ observedAtEpochMs: input.nowEpochMs() });
    return {
        enqueue: {
            authSession: request.session,
            generationId: generation.generationId,
            ticketDigest: await hashAuthSecret(request.ticket),
            input: toAuthorisedWsClientInput(
                request.requestUrl,
                request.userAgent,
                generation.generationStartedAtEpochMs
            )
        },
        generation,
        expected: { id: request.session.sessionId, generationId: generation.generationId }
    };
}

async function writeAuthorisedWsConnect(
    input: RegisterWsRoutesInput,
    connect: AuthorisedWsConnect
): Promise<Either<AppInboxFailure, AuthorisedWsClientMutationResult> | undefined> {
    try {
        return await input.appClientInboxService.writeAuthorisedWsClientConnect(connect.enqueue);
    }
    catch (error) {
        console.error('Authorised WebSocket connect failed before its result', error);
        return undefined;
    }
}

async function registerAuthorisedWebSocket(
    context: Context,
    input: RegisterWsRoutesInput,
    connect: AuthorisedWsConnect
): Promise<Response> {
    try {
        const upgraded = input.upgradeWebSocket(context.req.raw);
        rememberAuthorisedWsConnection(
            connect.expected.id,
            connect.generation.generationId,
            toAuthorisedWsClientConnection(connect.enqueue)
        );
        input.socketServer.addConnection(
            new ConnectionContext({ id: connect.expected.id, socket: upgraded.socket, ...connect.generation })
        );
        return upgraded.response;
    }
    catch (error) {
        console.error('WebSocket upgrade failed after its connect committed', error);
        input.socketServer.releaseExpectedConnection(connect.expected);
        await enqueueGenerationDisconnect(input, connect, 'websocket-upgrade-failed');
        return context.json({ error: 'WebSocket setup failed' }, 500);
    }
}

interface UnwrittenConnect {
    readonly connect: AuthorisedWsConnect;
    readonly written: Either<AppInboxFailure, AuthorisedWsClientMutationResult> | undefined;
}

/** A connect whose outcome the route did not see may still commit, so its generation is closed behind it. */
async function toUnwrittenConnectResponse(
    context: Context,
    input: RegisterWsRoutesInput,
    { connect, written }: UnwrittenConnect
): Promise<Response> {
    const generation = { sessionId: connect.expected.id, generationId: connect.generation.generationId };
    if (written?.right?.status === 'ticket-rejected') {
        return toWsTicketRejectionResponse(context, generation);
    }
    if (written?.right?.status === 'inactive') {
        return context.json({ error: 'WebSocket generation is no longer active' }, 409);
    }
    await enqueueGenerationDisconnect(input, connect, 'websocket-connect-failed');
    const failure = written?.left;
    return Response.json(
        { error: failure?.message ?? 'WebSocket connect failed' },
        { status: failure?.status ?? 503 }
    );
}

async function enqueueGenerationDisconnect(
    input: RegisterWsRoutesInput,
    connect: AuthorisedWsConnect,
    reason: string
): Promise<void> {
    try {
        await input.appClientInboxService.enqueueAuthorisedWsClientDisconnect({
            connection: toAuthorisedWsClientConnection(connect.enqueue),
            disconnectedAtEpochMs: Math.max(input.nowEpochMs(), connect.generation.generationStartedAtEpochMs),
            reason
        });
    }
    catch (error) {
        console.error('WebSocket generation disconnect could not be enqueued', error);
    }
}

function toWsTicketRejectionResponse(
    context: Context,
    generation: Readonly<{ sessionId: string; generationId: string | null; }>
): Response {
    const rejection = new RequestAuthFailure({
        kind: 'authentication',
        code: 'authentication-required',
        status: 401,
        message: 'Unauthorized: Invalid or expired websocket auth ticket',
        details: generation
    });
    console.warn(rejection);
    return toAuthErrorResponse(context, rejection);
}

export function toAuthorisedWsClientInput(
    url: URL,
    userAgent?: string,
    connectedAtEpochMs?: number
): RegisterAuthorisedWsClientInput {
    const applicationId = readNonEmptySearchParam(url, 'applicationId');
    const workspaceId = readNonEmptySearchParam(url, 'workspaceId');

    return {
        ...(applicationId ? { applicationId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(userAgent ? { userAgent } : {}),
        ...(connectedAtEpochMs === undefined ? {} : { connectedAtEpochMs })
    };
}

export function toAuthorisedWsClientDisconnectInput(
    input: RallarWsLifecycleCloseInput
): ToAuthorisedWsClientDisconnectEnqueueInput {
    return {
        connection: readAuthorisedWsConnection(input),
        disconnectedAtEpochMs: input.disconnectedAtEpochMs,
        reason: input.reason
    };
}

export function toGroupPresenceSessionCleanupInput(
    input: RallarWsLifecycleCloseInput
): GroupPresenceSessionCleanupAppInboxPayload {
    return {
        connection: readAuthorisedWsConnection(input),
        disconnectedAtEpochMs: input.disconnectedAtEpochMs,
        reason: input.reason
    };
}

function isWebSocketUpgradeHeader(upgrade?: string): boolean {
    return upgrade?.trim().toLowerCase() === 'websocket';
}

function readNonEmptySearchParam(url: URL, name: string): string | undefined {
    const value = url.searchParams.get(name)?.trim();
    return value ? value : undefined;
}
