import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import type { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

export function installRtcSignalingWsTopic(service: WsQueueBoxServerService): void {
    service.onInboxMessageDo(AppTopics.rtcSignaling, {
        onMessage: (
            message: ALMessage,
            _entry: ResourceEntry,
            server: JsonWebSocketServer
        ): Promise<void> => {
            if (message.route.topicId !== AppTopics.rtcSignaling) {
                return Promise.resolve();
            }
            const signaling = JSON.parse(message.payload.resource) as QRtcSignalingMessage;
            if (!signaling || typeof signaling.toId !== 'string') {
                throw new TypeError('Invalid RTC signaling message');
            }
            server.send(signaling.toId, message);
            return Promise.resolve();
        }
    });
}
