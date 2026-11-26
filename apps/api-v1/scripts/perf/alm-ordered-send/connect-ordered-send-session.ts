import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ConnectionContext, type JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    releaseAuthorisedWsCloseFacts,
    rememberAuthorisedWsConnection
} from '../../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';

export interface ConnectOrderedSendSessionInput {
    readonly socketServer: JsonWebSocketServer;
    /** The session's one id: its peer id, its connection's id and its principal. */
    readonly sessionPeerId: string;
    /** The application and workspace of the run's room: the scope the session's connect proved. */
    readonly scope: StateScope;
    /** What the server writes the session's frames to. */
    readonly socket: ConnectionContext.Socket;
    readonly connectedAtEpochMs: number;
    /** How long the session's authorisation holds from its connect: past the end of the run. */
    readonly authorisationLifetimeMs: number;
}

/** Disconnects the session at the epoch time given and forgets the facts of its connect. */
export type OrderedSendSessionDisconnect = (disconnectedAtEpochMs: number) => void;

/**
 * Connects one session of the run to an instance as the API's upgrade route connects a browser's socket once its
 * authorised connect committed: the facts of the connect remembered for the connection's generation, the connection
 * registered, and its open dispatched. No connect is written to the database, and no socket is opened: the server
 * writes the session's frames to `socket`. Returns what disconnects the session.
 */
export function connectOrderedSendSession(input: ConnectOrderedSendSessionInput): OrderedSendSessionDisconnect {
    const { socketServer, sessionPeerId, connectedAtEpochMs } = input;
    const connection = new ConnectionContext({
        id: sessionPeerId,
        socket: input.socket,
        ...socketServer.mintConnectionGeneration({ observedAtEpochMs: connectedAtEpochMs })
    });
    rememberAuthorisedWsConnection(sessionPeerId, connection.generationId, toConnectFacts(input, connection));
    if (socketServer.registerConnection(connection)) {
        socketServer.dispatchConnectionOpen(connection);
    }
    return (disconnectedAtEpochMs) => {
        socketServer.dispatchConnectionClose(connection, 1000, 'ordered-send-run-ended');
        releaseAuthorisedWsCloseFacts({
            sessionId: sessionPeerId,
            generationId: connection.generationId,
            generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
            disconnectedAtEpochMs,
            reason: 'ordered-send-run-ended'
        });
    };
}

/** What the upgrade route remembers of an authorised connect; a server reads its scope, principal and expiry. */
function toConnectFacts(
    input: ConnectOrderedSendSessionInput,
    connection: ConnectionContext
): ClientAuthorisedWsSessionConnectAppInboxPayload {
    const { sessionPeerId, connectedAtEpochMs } = input;
    const expiresAtEpochMs = connectedAtEpochMs + input.authorisationLifetimeMs;
    return {
        authSession: {
            clientId: sessionPeerId,
            username: sessionPeerId,
            sessionId: sessionPeerId,
            issuedAtEpochMs: connectedAtEpochMs,
            expiresAtEpochMs
        },
        generationId: connection.generationId,
        generationStartedAtEpochMs: connection.generationStartedAtEpochMs,
        scope: input.scope,
        principalId: sessionPeerId,
        clientInstanceId: sessionPeerId,
        displayName: sessionPeerId,
        userAgent: null,
        platform: 'web',
        capabilities: [],
        expiresAtEpochMs
    };
}
