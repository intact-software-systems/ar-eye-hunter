import {WsQueueBoxInboxDto, WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {ResourceEntry} from "@shared/queuebox/ResourceEntry.ts";
import {JsonWebSocketServer} from "@shared/websocket/JsonWebSocketServer.ts";
import {QRtcSignalingMessage,} from "@shared/webrtc/QRtcSignalingContracts.ts";

export function initWsRtcSignaling(
    topicId: string,
    wsQBoxServerService: WsQueueBoxServerService
): void {
    wsQBoxServerService
        .onInboxMessageDo(
            topicId,
            {
                onMessage: (value: WsQueueBoxInboxDto, _: ResourceEntry, server: JsonWebSocketServer) => {

                    const msg = JSON.parse(value.data.payload.resource) as QRtcSignalingMessage;
                    if (msg === undefined) {
                        return Promise.reject("Invalid signaling message:");
                    }

                    console.log(`Received signaling message: ${JSON.stringify(msg)}`)

                    // TODO: Check if toId is a client
                    // TODO: Update ALM protocol info, ttl, hopcounts, etc.

                    server.send(msg.toId, value.data)

                    return Promise.resolve();
                }
            }
        )
}
