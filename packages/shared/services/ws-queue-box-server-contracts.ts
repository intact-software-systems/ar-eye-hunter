import { ALMessage } from '../al-contracts/al-contract.ts';

export type WsServerResolvedRecipient = Readonly<{
    peerId: string;
    connectionId: string;
}>;

export type WsServerLiveSendStatus =
    | 'sent-live'
    | 'no-recipients'
    | 'partial-failure'
    | 'failed';

export type WsServerLiveSendFailure = Readonly<{
    peerId: string;
    connectionId: string;
    reason: string;
}>;

export type WsServerLiveSendResult = Readonly<{
    status: WsServerLiveSendStatus;
    message: ALMessage;
    recipients: readonly WsServerResolvedRecipient[];
    recipientCount: number;
    sentCount: number;
    failedCount: number;
    failures: readonly WsServerLiveSendFailure[];
}>;

export type WsServerTargetResolver = Readonly<{
    resolvePeerRecipients?: (
        peerId: string,
        message: ALMessage,
    ) => readonly WsServerResolvedRecipient[];
    resolveGroupRecipients?: (
        groupId: string,
        message: ALMessage,
    ) => readonly WsServerResolvedRecipient[];
    resolveBroadcastRecipients?: (
        scope: 'room' | 'world' | 'all',
        message: ALMessage,
    ) => readonly WsServerResolvedRecipient[];
    resolvePeerIdForConnection?: (
        connectionId: string,
        message: ALMessage,
    ) => string | undefined;
}>;

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
    }>
    | Readonly<{
        kind: 'outbox-send';
        topicId: string;
    }>
    | Readonly<{
        kind: 'no-local-recipient';
        topicId: string;
    }>;

export type WsDeliveryDiagnosticsSink = (event: WsDeliveryDiagnosticsEvent) => void;
