import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WebSocketServerMessageContext } from '@shared/services/queue-message-callbacks.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

import { decodeRtcSignalingRoute } from './decode-rtc-signaling-route.ts';

export function installRtcSignalingWsTopic(service: WsQueueBoxServerService): void {
    service.onInboxMessageDo(AppTopics.rtcSignaling, {
        onMessage: (
            message: ALMessage,
            _entry: ResourceEntry,
            context: WebSocketServerMessageContext
        ): Promise<void> => {
            if (message.route.topicId !== AppTopics.rtcSignaling) {
                return Promise.resolve();
            }
            const route = decodeRtcSignalingRoute(message);
            if (route.left) {
                throw new TypeError(route.left.message);
            }
            if (route.right) {
                context.server.send(route.right.toId, message);
            }
            return Promise.resolve();
        }
    });
}
