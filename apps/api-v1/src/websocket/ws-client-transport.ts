import {WsQueueBoxInboxDto, WsQueueBoxServerService} from "@shared/services/WsQueueBoxServerService.ts";
import {ResourceEntry} from "@shared/queuebox/ResourceEntry.ts";
import {ConnectionContext, JsonWebSocketServer} from "@shared/websocket/JsonWebSocketServer.ts";
import {AppTopics, ClientData} from "../../../../packages/shared/api/api-config.ts";
import {wsQBoxServerService} from "./ws-initialise.ts";
import {toALMessage} from "../../../../packages/shared/al-contracts/al-contract.ts";
import {findClientById} from "../clients/client-repository.ts";

export async function addWsAndPublishClient(sessionId: string, socket: WebSocket): Promise<void> {
    const clientData = findClientById(sessionId)
    if (clientData === undefined) {
        throw new Error("Client not found: " + sessionId)
    }

    wsQBoxServerService.socket.addConnection(new ConnectionContext(sessionId, socket))

    await wsQBoxServerService.enqueueOutboxIfAbsent(
        toALMessage<ClientData>(
            sessionId,
            AppTopics.client,
            clientData
        )
    )
}

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