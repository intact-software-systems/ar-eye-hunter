import {ALMessage} from "@shared/al-contracts/al-contract.ts";
import {chatTopicId, ClientData, clientTopicId, rtcSignalingTopicId} from "@shared/api/api-config.ts";
import {postClientData, readClients} from "./api-integration.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";
import {QRtcSignalingMessage} from "@shared/webrtc/QRtcSignalingContracts.ts";

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
            "ws-topic-router",
            {
                onMessage: async (entry) => {
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
                                console.log(`Connect to peer over RTC: ${peer.clientId}`);
                                await webRtcQueueBox.connectToPeer(peer.clientId)
                            }

                            break;
                        }
                        case rtcSignalingTopicId:
                            console.log('Received rtc signaling message. Accepting peer if absent? Should I really?')
                            await webRtcQueueBox.acceptPeerIfAbsent(data.id.sender, JSON.parse(data.payload.resource) as QRtcSignalingMessage)
                            break
                    }
                }
            }
        )
}

