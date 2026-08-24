import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { WsServerResolvedRecipient } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

export function resolveWsFixedTopologyTargetRecipients(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage
): readonly WsServerResolvedRecipient[] | undefined {
    const targets = message.targets;
    if (
        targets?.mode !== 'broadcast' ||
        targets.recipientPeerIds === undefined ||
        message.id.senderId !== 'rallar-server' ||
        message.route.topicId !== AppTopics.overlayTopology ||
        message.payload.typeId !== AppTopics.overlayTopology
    ) {
        return undefined;
    }
    return targets.recipientPeerIds.flatMap((peerId) => {
        const context = webSocketServer.connections.get(peerId);
        return context?.isOpen ? [{ peerId, connectionId: peerId }] : [];
    });
}
