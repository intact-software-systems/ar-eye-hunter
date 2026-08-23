import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

export function installChatWsTopic(service: WsQueueBoxServerService): void {
    service.onInboxMessageDo(AppTopics.chat, {
        onMessage: (
            message: ALMessage,
            _entry: ResourceEntry,
            server: JsonWebSocketServer
        ): Promise<void> => {
            if (message.route.topicId === AppTopics.chat) {
                server.broadcast(message);
            }
            return Promise.resolve();
        }
    });
}
