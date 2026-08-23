import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { resolveStateSyncRecipients, type StateSyncRoutingOptions } from './state-sync-routing.ts';

export function toStateSyncConnectionFilter(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {}
): ((context: ConnectionContext) => boolean) | undefined {
    const recipients = resolveStateSyncRecipients(webSocketServer, message, options);
    if (!recipients) {
        return undefined;
    }

    const connectionIds = new Set(recipients.map((recipient) => recipient.connectionId));
    return (context) => connectionIds.has(context.id);
}

export function sendStateSyncMessage(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage,
    options: StateSyncRoutingOptions = {}
): number {
    const recipients = resolveStateSyncRecipients(webSocketServer, message, options);
    if (!recipients) {
        return webSocketServer.broadcast(message);
    }
    if (recipients.length === 0) {
        return 0;
    }

    const encoded = webSocketServer.encode(message);
    let sent = 0;
    for (const recipient of recipients) {
        try {
            webSocketServer.sendEncoded(recipient.connectionId, encoded);
            sent += 1;
        }
        catch (error) {
            console.error('State sync send failed:', error);
        }
    }
    return sent;
}
