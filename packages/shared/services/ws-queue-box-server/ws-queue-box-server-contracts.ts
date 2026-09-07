import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALNackReason } from '../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';

export interface WsServerResolvedRecipient {
    readonly peerId: string;
    readonly connectionId: string;
}

export type WsServerLiveSendStatus =
    | 'sent-live'
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
    | Readonly<{ authorized: true; roomRecipientPeerIds?: readonly string[]; }>
    | Readonly<{
        authorized: false;
        reason: ALNackReason;
        rejectionCode?: ALMessageRejection['code'];
        logMessage: string;
        sendNack: boolean;
        serverSnapshotVersion?: number;
    }>;

export interface WsServerInboundAuthorizer {
    authorize(message: ALMessage): Promise<WsServerInboundAuthorization>;
}
