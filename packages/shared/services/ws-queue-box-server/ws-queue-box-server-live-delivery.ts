import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { EncodedJsonWebSocketMessage, JsonWebSocketServer } from '../../websocket/JsonWebSocketServer.ts';
import type {
    WsServerLiveSendFailure,
    WsServerLiveSendResult,
    WsServerLiveSendStatus,
    WsServerResolvedRecipient
} from './ws-queue-box-server-contracts.ts';
import type { WsQueueBoxServerDeliveryReporting } from './ws-queue-box-server-delivery-reporting.ts';
import type { WsQueueBoxServerTargetResolution } from './ws-queue-box-server-target-resolution.ts';

export namespace WsQueueBoxServerLiveDelivery {
    export interface Dependencies {
        readonly socket: JsonWebSocketServer;
        readonly targetResolution: WsQueueBoxServerTargetResolution;
        readonly deliveryReporting: WsQueueBoxServerDeliveryReporting;
    }

    export interface EncodedAttempt {
        readonly encoded: EncodedJsonWebSocketMessage | null;
        readonly failureReason: string | null;
    }

    export interface SendAttempt {
        readonly sentCount: number;
        readonly failures: readonly WsServerLiveSendFailure[];
    }
}

export class WsQueueBoxServerLiveDelivery {
    readonly #socket: JsonWebSocketServer;
    readonly #targetResolution: WsQueueBoxServerTargetResolution;
    readonly #deliveryReporting: WsQueueBoxServerDeliveryReporting;

    constructor(dependencies: WsQueueBoxServerLiveDelivery.Dependencies) {
        this.#socket = dependencies.socket;
        this.#targetResolution = dependencies.targetResolution;
        this.#deliveryReporting = dependencies.deliveryReporting;
    }

    sendToTargets(message: ALMessage): number {
        return this.sendToTargetsWithResult(message).sentCount;
    }

    sendToTargetsWithResult(message: ALMessage): WsServerLiveSendResult {
        const recipients = this.#targetResolution.resolveOutboundRecipients(message);
        if (recipients.length === 0) {
            this.#deliveryReporting.recordDiagnostics({
                kind: 'no-local-recipient',
                topicId: message.route.topicId
            });
            return noRecipientResult(message);
        }

        const encodedAttempt = this.toEncodedAttempt(message);
        if (!encodedAttempt.encoded) {
            return encodingFailureResult(message, recipients, encodedAttempt.failureReason!);
        }

        const sendAttempt = this.sendEncodedToRecipients(encodedAttempt.encoded, recipients);
        this.#deliveryReporting.recordDiagnostics({
            kind: 'live-send',
            topicId: message.route.topicId,
            recipientCount: recipients.length,
            sentCount: sendAttempt.sentCount,
            payloadBytes: encodedAttempt.encoded.text.length
        });
        return toLiveSendResult(message, recipients, sendAttempt);
    }

    sendToResolvedPeer(
        peerId: string,
        message: ALMessage,
        encoded?: EncodedJsonWebSocketMessage
    ): number {
        const recipients = this.#targetResolution.resolveRepairRecipients(message, [peerId]);
        const encodedMessage = encoded ?? this.tryEncodeDirectMessage(message);
        if (!encodedMessage) {
            return 0;
        }
        return this.sendEncodedToRecipients(encodedMessage, recipients).sentCount;
    }

    tryEncodeDirectMessage(message: ALMessage): EncodedJsonWebSocketMessage | undefined {
        const attempt = this.toEncodedAttempt(message);
        return attempt.encoded ?? undefined;
    }

    private toEncodedAttempt(message: ALMessage): WsQueueBoxServerLiveDelivery.EncodedAttempt {
        try {
            return { encoded: this.#socket.encode(message), failureReason: null };
        }
        catch (error) {
            const runtimeError = error instanceof Error ? error : new Error(String(error));
            console.error(`Error encoding WS server message ${message.id.msgId}`, runtimeError);
            return { encoded: null, failureReason: runtimeError.message };
        }
    }

    private sendEncodedToRecipients(
        encoded: EncodedJsonWebSocketMessage,
        recipients: readonly WsServerResolvedRecipient[]
    ): WsQueueBoxServerLiveDelivery.SendAttempt {
        let sentCount = 0;
        const failures: WsServerLiveSendFailure[] = [];
        for (const recipient of recipients) {
            try {
                this.#socket.sendEncoded(recipient.connectionId, encoded);
                sentCount += 1;
            }
            catch (error) {
                const runtimeError = error instanceof Error ? error : new Error(String(error));
                failures.push({
                    peerId: recipient.peerId,
                    connectionId: recipient.connectionId,
                    reason: runtimeError.message
                });
                console.error(
                    `Error sending WS server message to ${recipient.connectionId}`,
                    runtimeError
                );
            }
        }
        return { sentCount, failures };
    }
}

function noRecipientResult(message: ALMessage): WsServerLiveSendResult {
    return {
        status: 'no-recipients',
        message,
        recipients: [],
        recipientCount: 0,
        sentCount: 0,
        failedCount: 0,
        failures: []
    };
}

function encodingFailureResult(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[],
    reason: string
): WsServerLiveSendResult {
    return {
        status: 'failed',
        message,
        recipients,
        recipientCount: recipients.length,
        sentCount: 0,
        failedCount: recipients.length,
        failures: recipients.map((recipient) => ({
            peerId: recipient.peerId,
            connectionId: recipient.connectionId,
            reason
        }))
    };
}

function toLiveSendResult(
    message: ALMessage,
    recipients: readonly WsServerResolvedRecipient[],
    attempt: WsQueueBoxServerLiveDelivery.SendAttempt
): WsServerLiveSendResult {
    return {
        status: toLiveSendStatus(recipients.length, attempt.sentCount, attempt.failures.length),
        message,
        recipients,
        recipientCount: recipients.length,
        sentCount: attempt.sentCount,
        failedCount: attempt.failures.length,
        failures: attempt.failures
    };
}

function toLiveSendStatus(
    recipientCount: number,
    sentCount: number,
    failedCount: number
): WsServerLiveSendStatus {
    if (recipientCount === 0) {
        return 'no-recipients';
    }
    if (failedCount === 0) {
        return 'sent-live';
    }
    return sentCount > 0 ? 'partial-failure' : 'failed';
}
