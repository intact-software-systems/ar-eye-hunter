import {ALMessage} from "@shared/al-contracts/al-contract.ts";
import {chatTopicId, ClientData, clientTopicId, rtcSignalingTopicId} from "@shared/api/api-config.ts";
import {postClientData, readClients} from "./api-integration.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";

export const chatMessageById = new Map<string, ALMessage>();
export const clientDataById = new Map<string, ClientData>();

export async function initialise(
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcQueueBox: WebRtcQueueBoxClientService,
    appClientData: ClientData
) {
    await postAndReadClientData(appClientData)

    connectWsCallbacksToCache(webSocketQueueBox, appClientData, webRtcQueueBox);
}

async function postAndReadClientData(
    appClientData: ClientData
) {
    await postClientData(appClientData)

    const clientsFromApi: ClientData[] = await readClients()

    for (const client of clientsFromApi) {
        clientDataById.set(client.clientId, client)
    }
}

function connectWsCallbacksToCache(
    webSocketQueueBox: WsQueueBoxClientService,
    appClientData: ClientData,
    webRtcQueueBox: WebRtcQueueBoxClientService
) {
    webSocketQueueBox
        .onInboxMessageDo(
            "ws-data-cache-router",
            {
                onMessage: async (entry) => {
                    console.log(`ws-data-cache-router: ${entry.resource}`);

                    const data = JSON.parse(entry.resource) as ALMessage;

                    switch (data.payload.typeId) {
                        case chatTopicId: {
                            chatMessageById.set(data.id.sender, data)
                            break;
                        }
                        case clientTopicId: {
                            const peer = JSON.parse(data.payload.resource) as ClientData;
                            clientDataById.set(peer.clientId, peer)

                            if (peer.clientId === appClientData.clientId) {
                                console.log('Received my own client data. Ignoring it')
                            } else {
                                await webRtcQueueBox.connectToPeer(peer.clientId)
                            }

                            break;
                        }
                        case rtcSignalingTopicId:
                            console.log('Received rtc signaling message')

                            break
                    }
                }
            }
        )
}

