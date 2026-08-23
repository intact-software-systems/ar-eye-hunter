import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { sendStateSyncMessage } from '../../state-sync/state-sync-websocket-publication.ts';

export function installTopologyWsTopics(service: WsQueueBoxServerService): void {
    installBroadcastTopic(service, AppTopics.graphs, (server, message) => {
        server.broadcast(message);
    });
    installBroadcastTopic(service, AppTopics.overlayTopology, (server, message) => {
        sendStateSyncMessage(server, message);
    });
}

function installBroadcastTopic(
    service: WsQueueBoxServerService,
    topicId: string,
    publish: (server: JsonWebSocketServer, message: ALMessage) => void
): void {
    const onMessage = (
        message: ALMessage,
        _entry: ResourceEntry,
        server: JsonWebSocketServer
    ): Promise<void> => {
        if (message.route.topicId === topicId) {
            publish(server, message);
        }
        return Promise.resolve();
    };
    service.onInboxMessageDo(topicId, { onMessage });
    service.onOutboxMessageDo(topicId, { onMessage });
}
