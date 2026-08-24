import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { decodeStateSyncMessage, type StateSyncDecodeResult } from './state-sync-payload.ts';
import { resolveDecodedStateSyncRecipients, type StateSyncRoutingOptions } from './state-sync-routing.ts';

export interface SendDecodedStateSyncMessageInput {
    readonly webSocketServer: JsonWebSocketServer;
    readonly message: ALMessage;
    readonly decoded: StateSyncDecodeResult;
    readonly routing?: StateSyncRoutingOptions;
}

export function sendStateSyncMessage(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {}
): number {
    return sendDecodedStateSyncMessage({
        webSocketServer,
        message,
        decoded: decodeStateSyncMessage(message),
        routing: options
    });
}

export function sendDecodedStateSyncMessage(
    input: SendDecodedStateSyncMessageInput
): number {
    const recipients = resolveDecodedStateSyncRecipients(
        input.webSocketServer,
        input.decoded,
        input.routing
    );
    if (!recipients || recipients.length === 0) {
        return 0;
    }

    const encoded = input.webSocketServer.encode(input.message);
    let sentCount = 0;
    for (const recipient of recipients) {
        try {
            input.webSocketServer.sendEncoded(recipient.connectionId, encoded);
            sentCount += 1;
        }
        catch (error) {
            console.error('State sync send failed:', error);
        }
    }
    return sentCount;
}
