import { type ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { RallarWsLifecycleCloseInput } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

interface AuthorisedWsClientDisconnectInput {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
}

const AUTHORISED_CONNECTIONS = new Map<string, ClientAuthorisedWsSessionConnectAppInboxPayload>();

export interface AuthorisedWsConnectionEligibility {
    readonly scope: ClientAuthorisedWsSessionConnectAppInboxPayload['scope'];
    readonly principalId: string;
    readonly expiresAtEpochMs: number;
}

export function rememberAuthorisedWsConnection(
    sessionId: string,
    generationId: string,
    connection: ClientAuthorisedWsSessionConnectAppInboxPayload
): void {
    AUTHORISED_CONNECTIONS.set(
        toAuthorisedConnectionKey(sessionId, generationId),
        connection
    );
}

export function readAuthorisedWsConnectionIdentity(
    connection: ConnectionContext
): Readonly<{ principalId: string; }> | undefined {
    const authorised = AUTHORISED_CONNECTIONS.get(
        toAuthorisedConnectionKey(connection.id, connection.generationId)
    );
    if (
        !authorised ||
        authorised.generationStartedAtEpochMs !== connection.generationStartedAtEpochMs
    ) {
        return undefined;
    }
    return { principalId: authorised.principalId };
}

export function readAuthorisedWsConnectionEligibility(
    connection: ConnectionContext
): AuthorisedWsConnectionEligibility | undefined {
    const authorised = AUTHORISED_CONNECTIONS.get(
        toAuthorisedConnectionKey(connection.id, connection.generationId)
    );
    if (
        !authorised || authorised.generationId !== connection.generationId ||
        authorised.generationStartedAtEpochMs !== connection.generationStartedAtEpochMs
    ) {
        return undefined;
    }
    return {
        scope: authorised.scope,
        principalId: authorised.principalId,
        expiresAtEpochMs: authorised.expiresAtEpochMs
    };
}

/**
 * Whether a socket here is its session's current connection: the generation the session entry of its principal's
 * client snapshot names, which the authorised connect writes cluster-wide before every upgrade (D269, D284).
 */
export async function readAuthorisedWsConnectionCurrentness(
    connection: ConnectionContext,
    readClientSnapshot: (ref: ClientPrincipalRef) => Promise<ClientSnapshot | undefined>
): Promise<boolean> {
    const facts = readAuthorisedWsConnectionEligibility(connection);
    if (!facts) {
        return false;
    }
    const snapshot = await readClientSnapshot({
        applicationId: facts.scope.applicationId,
        workspaceId: facts.scope.workspaceId,
        principalId: facts.principalId
    });
    return snapshot?.activeSessions.some((session) =>
        session.sessionId === connection.id && session.generationId === connection.generationId
    ) === true;
}

export function toAuthorisedWsClientDisconnectInput(
    input: RallarWsLifecycleCloseInput
): AuthorisedWsClientDisconnectInput {
    return {
        connection: readAuthorisedWsConnection(input),
        disconnectedAtEpochMs: input.disconnectedAtEpochMs,
        reason: input.reason
    };
}

export function releaseAuthorisedWsCloseFacts(
    input: RallarWsLifecycleCloseInput
): void {
    const key = toAuthorisedConnectionKey(input.sessionId, input.generationId);
    const connection = AUTHORISED_CONNECTIONS.get(key);
    if (
        connection &&
        connection.generationStartedAtEpochMs === input.generationStartedAtEpochMs
    ) {
        AUTHORISED_CONNECTIONS.delete(key);
    }
}

export function hasAuthorisedWsCloseFacts(
    input: RallarWsLifecycleCloseInput
): boolean {
    const connection = AUTHORISED_CONNECTIONS.get(
        toAuthorisedConnectionKey(input.sessionId, input.generationId)
    );
    return connection?.generationStartedAtEpochMs === input.generationStartedAtEpochMs;
}

export function readAuthorisedWsConnection(
    input: RallarWsLifecycleCloseInput
): ClientAuthorisedWsSessionConnectAppInboxPayload {
    const key = toAuthorisedConnectionKey(input.sessionId, input.generationId);
    const connection = AUTHORISED_CONNECTIONS.get(key);
    if (
        !connection ||
        connection.generationStartedAtEpochMs !== input.generationStartedAtEpochMs
    ) {
        throw new Error('Trusted authorised WebSocket connection facts are unavailable');
    }
    return connection;
}

function toAuthorisedConnectionKey(sessionId: string, generationId: string): string {
    return [sessionId, generationId].map(encodeURIComponent).join(':');
}
