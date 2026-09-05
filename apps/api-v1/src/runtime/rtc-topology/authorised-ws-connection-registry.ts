import { type ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { RallarWsLifecycleCloseInput } from '@shared-server/rallar-system/websocket/ws-lifecycle-service.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

interface AuthorisedWsClientDisconnectInput {
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly disconnectedAtEpochMs: number;
    readonly reason: string;
}

const AUTHORISED_CONNECTIONS = new Map<string, ClientAuthorisedWsSessionConnectAppInboxPayload>();

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
