import {WsQueueBoxInboxDto, WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {ResourceEntry} from "@shared/queuebox/ResourceEntry.ts";
import {JsonWebSocketServer} from "@shared/websocket/JsonWebSocketServer.ts";
import {AppTopics, RoomDetails} from "../../../../packages/shared/api/api-config.ts";
import {wsQBoxServerService} from "./ws-initialise.ts";
import {toALMessage} from "../../../../packages/shared/al-contracts/al-contract.ts";

export async function publishRoomDetails(roomDetails: RoomDetails) {
    await wsQBoxServerService.enqueueOutboxIfAbsent(
        toALMessage<RoomDetails>(
            roomDetails.createdBy,
            AppTopics.rooms,
            roomDetails
        )
    )
}

export function initRoomTransport(
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