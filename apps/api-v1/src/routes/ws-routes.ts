import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { type RegisterAuthorisedWsClientInput } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import type {
    AppClientInboxService
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
    toAuthorisedWsClientConnection,
    type ToAuthorisedWsClientDisconnectEnqueueInput
} from '@shared-server/rallar-system/client-state/inbox/authorised-ws-client-app-inbox.ts';
import { type GroupPresenceSessionCleanupAppInboxPayload } from '@shared-server/rallar-system/group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts';
import type { RallarWsLifecycleCloseInput } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { Hono, type Context } from 'jsr:@hono/hono@4.11.9';
import {
    readAuthorisedWsConnection,
    rememberAuthorisedWsConnection
} from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { toAuthErrorResponse } from '../services/request-auth-service.ts';

export interface WsRouteAuthInput {
    readonly sessionId: string;
    readonly ticket?: string;
}

export interface RegisterWsRoutesInput {
    readonly socketServer: JsonWebSocketServer;
    readonly appClientInboxService: Pick<AppClientInboxService, 'enqueueAuthorisedWsClientConnect'>;
    readonly requireWsAuthSession: (
        input: WsRouteAuthInput
    ) => Promise<IssuedAuthSession>;
}

export function registerWsRoutes(app: Hono, input: RegisterWsRoutesInput): void {
    app.get(
        '/api/ws/:sessionId',
        (context) => handleWebSocketUpgrade(context, input)
    );
}

async function handleWebSocketUpgrade(
    context: Context,
    input: RegisterWsRoutesInput
): Promise<Response> {
    if (!isWebSocketUpgradeHeader(context.req.header('upgrade'))) {
        return context.text('Expected Upgrade: websocket', 426);
    }

    let upgraded: Deno.WebSocketUpgrade | undefined;

    try {
        const sessionId = context.req.param('sessionId');
        const requestUrl = new URL(context.req.url);
        const ticket = requestUrl.searchParams.get('ticket') ?? undefined;
        const userAgent = context.req.header('user-agent');
        const authSession = await input.requireWsAuthSession({ sessionId, ticket });

        upgraded = Deno.upgradeWebSocket(context.req.raw);

        const socketServer = input.socketServer;
        const connection = socketServer.createConnectionContext(
            { id: authSession.sessionId, socket: upgraded.socket }
        );
        const connectInput = {
            authSession,
            generationId: connection.generationId,
            input: toAuthorisedWsClientInput(
                requestUrl,
                userAgent,
                connection.generationStartedAtEpochMs
            )
        };
        rememberAuthorisedWsConnection(
            connection.id,
            connection.generationId,
            toAuthorisedWsClientConnection(connectInput)
        );
        socketServer.addConnection(connection);
        await input.appClientInboxService.enqueueAuthorisedWsClientConnect(connectInput);

        console.log(`Upgrading connection for ID: ${sessionId}`);
        return upgraded.response;
    }
    catch (error) {
        console.error(error);
        if (upgraded) {
            try {
                upgraded.socket.close(1011, 'WebSocket setup failed');
            }
            catch (closeError) {
                console.error(closeError);
            }
            return upgraded.response;
        }

        return toAuthErrorResponse(context, error);
    }
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
