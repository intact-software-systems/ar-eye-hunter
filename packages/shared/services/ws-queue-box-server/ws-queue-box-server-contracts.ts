import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALNackReason } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { ConnectionContext } from '../../websocket/json-web-socket-server.ts';

export interface WsServerInboundConnectionScopeProof {
    readonly scope: StateScope;
    /** Present when the connection's authenticated principal is known. Required for principal publication. */
    readonly principalId?: string;
    readonly expiresAtEpochMs: number;
}

export interface WsServerInboundConnectionScopeReader {
    readAuthenticatedConnectionScope(connection: ConnectionContext): WsServerInboundConnectionScopeProof | undefined;
}

export interface WsServerResolvedRecipient {
    readonly peerId: string;
    readonly connectionId: string;
}

export type WsServerLiveSendStatus =
    | 'sent-live'
    | 'expired'
    | 'no-recipients'
    | 'partial-failure'
    | 'failed';

export interface WsServerLiveSendFailure {
    readonly peerId: string;
    readonly connectionId: string;
    readonly reason: string;
}

export interface WsServerLiveSendResult {
    readonly status: WsServerLiveSendStatus;
    readonly message: ALMessage;
    readonly recipients: readonly WsServerResolvedRecipient[];
    readonly recipientCount: number;
    readonly sentCount: number;
    readonly failedCount: number;
    readonly failures: readonly WsServerLiveSendFailure[];
}

export interface WsServerLiveSendInputDto {
    readonly message: ALMessage;
    /** A cluster notice's already resolved deadline; ordinary live sends derive one from the message. */
    readonly expiresAtMs?: number;
    readonly recipientSessionIds?: readonly string[];
    readonly admittedPeerIds?: readonly string[];
    /** Explicit recipient scope; null or absent proof refuses generic unicast, including server-originated sends. */
    readonly inboundScope?: StateScope | null;
    /** Rechecked at the final send for every fixed, scoped cluster notice audience. */
    readonly recipientScope?: StateScope;
    readonly recipientPrincipalId?: string;
    /** Broad notices still require a current authenticated connection, without inventing a scope. */
    readonly requireAuthenticatedRecipient?: boolean;
}

export interface WsServerTargetResolver {
    readonly resolvePeerRecipients?: (
        peerId: string,
        message: ALMessage
    ) => readonly WsServerResolvedRecipient[];
    readonly resolveGroupRecipients?: (
        groupId: string,
        message: ALMessage
    ) => readonly WsServerResolvedRecipient[];
    readonly resolveBroadcastRecipients?: (
        scope: 'room' | 'world' | 'all' | 'principal',
        message: ALMessage
    ) => readonly WsServerResolvedRecipient[];
    readonly resolvePeerIdForConnection?: (
        connectionId: string,
        message: ALMessage
    ) => string | undefined;
}

export type WsOutboxDeliveryOutcome =
    | Readonly<{
        status: 'sent';
        messageId: string;
    }>
    | Readonly<{
        status: 'no-current-recipient';
        messageId: string;
    }>
    | Readonly<{
        status: 'retryable-transport-failure';
        messageId: string;
        reason: string;
    }>;

export type WsDeliveryDiagnosticsEvent =
    | Readonly<{
        kind: 'live-send';
        topicId: string;
        recipientCount: number;
        sentCount: number;
        // Serialized message length in UTF-16 code units (exact bytes for ASCII JSON),
        // measured once from the shared encoding; egress bytes = payloadBytes * sentCount.
        payloadBytes: number;
    }>
    | Readonly<{
        kind: 'outbox-send';
        topicId: string;
        payloadBytes: number;
    }>
    | Readonly<{
        kind: 'no-local-recipient';
        topicId: string;
    }>;

export type WsDeliveryDiagnosticsSink = (event: WsDeliveryDiagnosticsEvent) => void;

export type WsServerInboundAuthorization =
    | Readonly<{
        authorized: true;
        /** Absent when the authorizer resolved no room audience: the target resolver owns delivery. */
        roomAudience?: WsServerRoomAudience;
    }>
    | Readonly<{
        authorized: false;
        reason: ALNackReason;
        rejectionCode?: ALMessageRejection['code'];
        logMessage: string;
        sendNack: boolean;
        serverSnapshotVersion?: number;
    }>;

/** The authorized room sessions, read at one snapshot version. */
export interface WsServerRoomAudience {
    readonly recipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
}

export interface WsServerInboundAuthorizer {
    /** Whether a refusal answers its origin with a NACK; the service's addressee refusal follows it too (C3). */
    readonly sendNacks: boolean;
    authorize(message: ALMessage): Promise<WsServerInboundAuthorization>;
}
