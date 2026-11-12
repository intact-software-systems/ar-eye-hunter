import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';
import type { PersistedWebSocketTicket } from '@shared-server/rallar-system/auth/persistence/persisted-auth-ticket.ts';
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
import { decodeALTraceId, newALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { Either } from '@shared/resilience/Either.ts';
import type { ExpectedConnectionHolds } from '@shared/websocket/expected-connection-holds.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import {
    readAuthorisedWsConnection,
    rememberAuthorisedWsConnection
} from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { RequestAuthFailure, toAuthErrorResponse } from '../services/request-auth-service.ts';

/** Longer than the connect's completion wait plus a handshake: a socket that neither opens nor closes stops holding rows. */
const EXPECTED_CONNECTION_TTL_MS = 120_000;

/** The per-connection state carried through `server.upgrade(request, { data })` into the Bun websocket handlers. */
export interface ApiWebSocketConnectionData {
    readonly sessionId: string;
    readonly generationId: string;
    readonly generationStartedAtEpochMs: number;
}

export interface RegisterWsRoutesInput {
    readonly socketServer: JsonWebSocketServer;
    readonly appClientInboxService: Pick<
        AppClientInboxService,
        'writeAuthorisedWsClientConnect' | 'enqueueAuthorisedWsClientDisconnect'
    >;
    readonly readWsConnectTicket: (ticketDigest: string) => Promise<PersistedWebSocketTicket | undefined>;
    readonly readWsConnectSession: (sessionId: string) => Promise<PersistedAuthSession | undefined>;
    readonly upgradeWebSocket: (request: Request, connection: ApiWebSocketConnectionData) => boolean;
    readonly nowEpochMs: () => number;
}

export type RegisterWsRoutesDependencies = Omit<RegisterWsRoutesInput, 'upgradeWebSocket'>;

export type ApiWebSocketUpgradeOutcome =
    | { readonly kind: 'upgraded'; }
    | { readonly kind: 'response'; readonly response: Response; }
    | { readonly kind: 'passthrough'; };

interface AuthorisedWsConnect {
    readonly enqueue: ToAuthorisedWsClientConnectEnqueueInput;
    readonly generation: JsonWebSocketServer.ConnectionGeneration;
    readonly expected: ExpectedConnectionHolds.Expectation;
}

/**
 * The fetch-boundary WebSocket upgrade. Under Bun the upgrade must happen in the `fetch` handler of
 * `Bun.serve`, where `server.upgrade(request, { data })` is in scope; it is not a Hono route.
 */
export async function upgradeApiWebSocket(
    request: Request,
    input: RegisterWsRoutesInput
): Promise<ApiWebSocketUpgradeOutcome> {
    const sessionId = readWsSessionId(request.url);
    if (sessionId === undefined) {
        return { kind: 'passthrough' };
    }
    if (!isWebSocketUpgradeHeader(request.headers.get('upgrade'))) {
        return { kind: 'response', response: new Response('Expected Upgrade: websocket', { status: 426 }) };
    }
    const requestUrl = new URL(request.url);
    const ticket = requestUrl.searchParams.get('ticket');
    const ticketDigest = ticket ? await hashAuthSecret(ticket) : undefined;
    const session = ticketDigest ? await readTicketedWsSession(input, { sessionId, ticketDigest }) : undefined;
    if (!ticketDigest || session === undefined) {
        return {
            kind: 'response',
            response: toWsTicketRejectionResponse({ sessionId, generationId: null })
        };
    }
    const connect = createAuthorisedWsConnect(input, {
        session,
        ticketDigest,
        traceId: decodeALTraceId(request.headers.get('x-request-id')).right ?? newALTraceId(),
        requestUrl,
        userAgent: request.headers.get('user-agent') ?? undefined
    });
    input.socketServer.expectedConnections.expect(connect.expected);
    const written = await writeAuthorisedWsConnect(input, connect);
    if (written?.right?.status === 'ok') {
        return registerAuthorisedWebSocket(request, input, connect);
    }
    input.socketServer.expectedConnections.release(connect.expected);
    return { kind: 'response', response: await writeUnwrittenConnectResponse(input, { connect, written }) };
}

/** The Bun `websocket` config that dispatches each upgraded socket's events into the shared server. */
export function createApiWebSocketHandlers(
    socketServer: JsonWebSocketServer
): Bun.WebSocketHandler<ApiWebSocketConnectionData> {
    // A session id maps to at most one live socket, but a Bun server socket is its own instance. A
    // replaced socket's close must dispatch to its own context so it never evicts the replacement:
    // dispatchConnectionClose deletes only when the map still points at that context.
    const connectionBySocket = new WeakMap<ConnectionContext.Socket, ConnectionContext>();
    return {
        open(ws) {
            const socket = ws;
            const connection = new ConnectionContext({
                id: ws.data.sessionId,
                socket,
                generationId: ws.data.generationId,
                generationStartedAtEpochMs: ws.data.generationStartedAtEpochMs
            });
            connectionBySocket.set(socket, connection);
            socketServer.registerConnection(connection);
            socketServer.dispatchConnectionOpen(connection);
        },
        message(ws, data) {
            const connection = connectionBySocket.get(ws);
            if (connection !== undefined) {
                void socketServer.dispatchConnectionMessage(connection, data);
            }
        },
        close(ws, code, reason) {
            const socket = ws;
            const connection = connectionBySocket.get(socket) ?? new ConnectionContext({
                id: ws.data.sessionId,
                socket,
                generationId: ws.data.generationId,
                generationStartedAtEpochMs: ws.data.generationStartedAtEpochMs
            });
            socketServer.dispatchConnectionClose(connection, code, reason);
        }
    };
}

/** The `Bun.serve` fetch and websocket pair that upgrades API WebSockets at the boundary and falls back to the app. */
export function createApiWebSocketServeHandlers(
    dependencies: RegisterWsRoutesDependencies,
    app: { fetch: (request: Request) => Response | Promise<Response>; }
): {
    readonly fetch: (request: Request, server: Bun.Server<ApiWebSocketConnectionData>) => Promise<Response | void>;
    readonly websocket: Bun.WebSocketHandler<ApiWebSocketConnectionData>;
} {
    return {
        fetch: async (request, server) => {
            const outcome = await upgradeApiWebSocket(request, {
                ...dependencies,
                upgradeWebSocket: (request, connection) => server.upgrade(request, { data: connection })
            });
            if (outcome.kind === 'upgraded') {
                return;
            }
            if (outcome.kind === 'response') {
                return outcome.response;
            }
            return app.fetch(request);
        },
        websocket: createApiWebSocketHandlers(dependencies.socketServer)
    };
}

function readWsSessionId(url: string): string | undefined {
    const match = /^\/api\/ws\/([^/]+)$/u.exec(new URL(url).pathname);
    if (match === null) {
        return undefined;
    }
    try {
        return decodeURIComponent(match[1]!);
    }
    catch {
        return undefined;
    }
}

/** The ticket is consumed by the connect's own transaction; the socket upgrades and registers only after it commits. */
async function registerAuthorisedWebSocket(
    request: Request,
    input: RegisterWsRoutesInput,
    connect: AuthorisedWsConnect
): Promise<ApiWebSocketUpgradeOutcome> {
    if (request.signal.aborted) {
        return {
            kind: 'response',
            response: await writeClosedGenerationResponse(input, { connect, reason: 'websocket-upgrade-abandoned' })
        };
    }
    try {
        const upgraded = input.upgradeWebSocket(request, {
            sessionId: connect.expected.id,
            generationId: connect.generation.generationId,
            generationStartedAtEpochMs: connect.generation.generationStartedAtEpochMs
        });
        if (!upgraded) {
            throw new Error('WebSocket upgrade was refused at the runtime boundary');
        }
        rememberAuthorisedWsConnection(
            connect.expected.id,
            connect.generation.generationId,
            toAuthorisedWsClientConnection(connect.enqueue)
        );
        return { kind: 'upgraded' };
    }
    catch (error) {
        console.error('WebSocket upgrade failed after its connect committed', error);
        return {
            kind: 'response',
            response: await writeClosedGenerationResponse(input, { connect, reason: 'websocket-upgrade-failed' })
        };
    }
}

interface TicketedWsSessionRead {
    readonly sessionId: string;
    readonly ticketDigest: string;
}

/**
 * Session ids are visible to every room peer, so only a live ticket bound to the path's session reaches the
 * session read and the session's lane; the connect's guarded delete still decides whether the ticket is spent.
 */
async function readTicketedWsSession(
    input: RegisterWsRoutesInput,
    request: TicketedWsSessionRead
): Promise<PersistedAuthSession | undefined> {
    const ticket = await input.readWsConnectTicket(request.ticketDigest);
    if (
        ticket === undefined || ticket.sessionId !== request.sessionId ||
        ticket.expiresAtEpochMs <= input.nowEpochMs()
    ) {
        return undefined;
    }
    const session = await input.readWsConnectSession(request.sessionId);
    return session?.sessionId === ticket.sessionId && session.clientId === ticket.clientId ? session : undefined;
}

interface CreateAuthorisedWsConnectInput {
    readonly session: PersistedAuthSession;
    readonly ticketDigest: string;
    readonly traceId: string;
    readonly requestUrl: URL;
    readonly userAgent: string | undefined;
}

function createAuthorisedWsConnect(
    input: RegisterWsRoutesInput,
    request: CreateAuthorisedWsConnectInput
): AuthorisedWsConnect {
    const generation = input.socketServer.mintConnectionGeneration({ observedAtEpochMs: input.nowEpochMs() });
    return {
        enqueue: {
            authSession: request.session,
            generationId: generation.generationId,
            ticketDigest: request.ticketDigest,
            traceId: request.traceId,
            input: toAuthorisedWsClientInput(
                request.requestUrl,
                request.userAgent,
                generation.generationStartedAtEpochMs
            )
        },
        generation,
        expected: {
            id: request.session.sessionId,
            generationId: generation.generationId,
            expiresAtEpochMs: generation.generationStartedAtEpochMs + EXPECTED_CONNECTION_TTL_MS
        }
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

interface ClosedGeneration {
    readonly connect: AuthorisedWsConnect;
    readonly reason: string;
}

/** A committed connect whose socket never registers costs its disconnect, never a lingering session. */
async function writeClosedGenerationResponse(
    input: RegisterWsRoutesInput,
    { connect, reason }: ClosedGeneration
): Promise<Response> {
    input.socketServer.expectedConnections.release(connect.expected);
    await enqueueGenerationDisconnect(input, connect, reason);
    return Response.json({ error: 'WebSocket setup failed' }, { status: 500 });
}

interface UnwrittenConnect {
    readonly connect: AuthorisedWsConnect;
    readonly written: Either<AppInboxFailure, AuthorisedWsClientMutationResult> | undefined;
}

/** A connect whose outcome the route did not see may still commit, so its generation is closed behind it. */
async function writeUnwrittenConnectResponse(
    input: RegisterWsRoutesInput,
    { connect, written }: UnwrittenConnect
): Promise<Response> {
    const generation = { sessionId: connect.expected.id, generationId: connect.generation.generationId };
    if (written?.right?.status === 'ticket-rejected') {
        return toWsTicketRejectionResponse(generation);
    }
    if (written?.right?.status === 'inactive') {
        return Response.json({ error: 'WebSocket generation is no longer active' }, { status: 409 });
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
    return toAuthErrorResponse(
        { json: (value, status) => Response.json(value, { status }) },
        rejection
    );
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

function isWebSocketUpgradeHeader(upgrade?: string | null): boolean {
    return upgrade?.trim().toLowerCase() === 'websocket';
}

function readNonEmptySearchParam(url: URL, name: string): string | undefined {
    const value = url.searchParams.get(name)?.trim();
    return value ? value : undefined;
}
