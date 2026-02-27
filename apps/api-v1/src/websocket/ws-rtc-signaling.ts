import {WsQueueBoxInboxDto, WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {ResourceEntry} from "@shared/queuebox/ResourceEntry.ts";
import {JsonWebSocketServer} from "@shared/websocket/JsonWebSocketServer.ts";
import {QRtcSignalingClientMessage, QRtcSignalingClientMsgType} from "@shared/webrtc/QRtcSignalingContracts.ts";

export function initWsRtcSignaling(
    topicId: string,
    wsQBoxServerService: WsQueueBoxServerService
): void {
    wsQBoxServerService
        .onInboxMessageDo(
            topicId,
            {
                onMessage: async (value: WsQueueBoxInboxDto, _: ResourceEntry, __: JsonWebSocketServer) => {

                    const msg = JSON.parse(value.data.payload.resource) as QRtcSignalingClientMessage;
                    if (msg === undefined) {
                        return;
                    }

                    switch (msg.type) {
                        case QRtcSignalingClientMsgType.Hello: {
                            // TODO: Disregard for now
                            break;
                        }

                        case QRtcSignalingClientMsgType.Signal: {


                            break;
                        }
                    }
                }
            }
        )
}
