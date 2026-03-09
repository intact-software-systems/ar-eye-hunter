import { WsQueueBoxInboxDto, WsQueueBoxServerService } from "@shared/services/WsQueueBoxServerService.ts";
import { ResourceEntry } from "@shared/queuebox/ResourceEntry.ts";
import { ConnectionContext, JsonWebSocketServer } from "@shared/websocket/JsonWebSocketServer.ts";
import { AppTopics, ClientData } from "@shared/api/api-config.ts";
import { toALMessage } from "@shared/al-contracts/al-contract.ts";
import * as clientRepository from "../repository/client-repository.ts";
import { findClientById } from "../repository/client-repository.ts";
import { wsQBoxServerService } from "./ws-initialise.ts";

export async function addWsAndPublishClient(sessionId: string, socket: WebSocket): Promise<void> {
    const clientData = findClientById(sessionId)
    if (clientData === undefined) {
        throw new Error("Client not found: " + sessionId)
    }

    wsQBoxServerService.socket.addConnection(new ConnectionContext(sessionId, socket))

    clientRepository.setClientDataById(
        clientData.sessionId,
        {
            ...clientData,
            isOnline: true
        }
    )

    await wsQBoxServerService.enqueueOutboxIfAbsent(
        toALMessage<ClientData>(
            sessionId,
            AppTopics.client,
            {
                ...clientData,
                isOnline: true
            }
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
                const clientData: ClientData = JSON.parse(value.data.payload.resource) as ClientData
                clientRepository.setClientDataById(clientData.sessionId, clientData)

                server.broadcast(value.data);
                return Promise.resolve();
            }
        }
    )
}
