import {WsQueueBoxInboxDto, WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {ResourceEntry} from "@shared/queuebox/ResourceEntry.ts";
import {JsonWebSocketServer} from "@shared/websocket/JsonWebSocketServer.ts";

export function initClientTransport(
    topicId: string,
    wsQBoxServerService: WsQueueBoxServerService
): void {
    wsQBoxServerService.onInboxMessageDo(
        topicId,
        {
            onMessage: (value: WsQueueBoxInboxDto, _: ResourceEntry, server: JsonWebSocketServer) => {
                server.broadcast(value.data);
                return Promise.resolve();
            }
        }
    )
}