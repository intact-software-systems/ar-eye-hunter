import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { WsServerResolvedRecipient } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

export function resolveWsFixedTopologyTargetRecipients(
    webSocketServer: JsonWebSocketServer,
    message: ALMessage
): readonly WsServerResolvedRecipient[] | undefined {
    const targets = message.targets;
    if (
        targets?.mode !== 'broadcast' ||
        targets.recipientPeerIds === undefined ||
        message.route.topicId !== AppTopics.overlayTopology ||
        message.payload.typeId !== AppTopics.overlayTopology
    ) {
        return undefined;
    }
    if (targets.scope !== 'room' || !targets.groupRef) {
        return [];
    }
    const expectedRoute = toAppQueueKey({ ...message.route, contextId: targets.groupRef.groupId });
    if (expectedRoute.contextId !== message.route.contextId) {
        return [];
    }
    return targets.recipientPeerIds.flatMap((peerId) => {
        const context = webSocketServer.connections.get(peerId);
        return context?.isOpen ? [{ peerId, connectionId: peerId }] : [];
    });
}
