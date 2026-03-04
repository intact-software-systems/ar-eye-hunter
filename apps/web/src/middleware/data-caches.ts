import {ALMessage} from "@shared/al-contracts/al-contract.ts";
import {AppTopics, ClientData, RoomDetails} from "@shared/api/api-config.ts";
import {readClients} from "./api-integration.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";
import {QRtcSignalingMessage} from "@shared/webrtc/QRtcSignalingContracts.ts";

export const chatMessageById = new Map<string, ALMessage>();
export const clientDataById = new Map<string, ClientData>();
export const roomDataById = new Map<string, RoomDetails>();

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
    //await postClientData(appClientData)

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
            "ws-topic-router",
            {
                onMessage: async (entry) => {
                    const data = JSON.parse(entry.resource) as ALMessage;

                    switch (data.payload.typeId) {
                        case AppTopics.chat: {
                            chatMessageById.set(data.id.sender, data)
                            break;
                        }

                        case AppTopics.client: {
                            const peer = JSON.parse(data.payload.resource) as ClientData;
                            clientDataById.set(peer.clientId, peer)

                            if (peer.clientId === appClientData.clientId) {
                                console.log('Received my own client data. Ignoring it')
                            } else {
                                console.log(`Connect to peer over RTC: ${peer.clientId}`);
                                await webRtcQueueBox.connectToPeer(peer.clientId)
                            }

                            break;
                        }

                        case AppTopics.rtcSignaling: {
                            console.log('Received rtc signaling message. Accept peer if absent.')
                            await webRtcQueueBox.acceptPeerIfAbsent(data.id.sender, JSON.parse(data.payload.resource) as QRtcSignalingMessage)

                            break
                        }

                        case AppTopics.rooms: {
                            const roomDetails = JSON.parse(data.payload.resource) as RoomDetails;

                            console.log(`Received room details: ${JSON.stringify(roomDetails)}`)

                            roomDataById.set(roomDetails.name, roomDetails)
                            break
                        }
                    }
                }
            }
        )
}

