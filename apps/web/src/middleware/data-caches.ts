import { ALMessage } from "@shared/al-contracts/al-contract.ts";
import { AppTopics, ClientData, RoomDetails } from "@shared/api/api-config.ts";
import { WebRtcQueueBoxClientService } from "@shared/services/WebRtcQueueBoxClientService.ts";
import { WsQueueBoxClientService } from "@shared/services/WsQueueBoxClientService.ts";
import { QRtcSignalingMessage } from "@shared/webrtc/QRtcSignalingContracts.ts";
import { listRooms } from "./api-integration.ts";

import * as clientsRepository from "../repository/clients-repository.ts";
import * as roomsRepository from "../repository/rooms-repository.ts";

export async function initialise(
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcQueueBox: WebRtcQueueBoxClientService,
    clientData: ClientData
) {
    try {
        (await listRooms())
            .forEach(room => {
                roomsRepository.setRoomDataById(room.name, room)
            })
    } catch (e) {
        console.error("Failed to list rooms:", e)
    }

    webSocketQueueBox
        .onInboxMessageDo(
            "ws-topic-router",
            {
                onMessage: async (entry) => {
                    const data = JSON.parse(entry.resource) as ALMessage;

                    switch (data.payload.typeId) {
                        case AppTopics.chat: {
                            console.log(`Received chat message: ${data.payload.resource}`)
                            break;
                        }

                        case AppTopics.client: {
                            const peer = JSON.parse(data.payload.resource) as ClientData;
                            clientsRepository.setClientDataById(peer.clientId, peer)
                            break;
                        }

                        case AppTopics.rtcSignaling: {
                            const signal = JSON.parse(data.payload.resource) as QRtcSignalingMessage;
                            console.log('RTC signaling message :' + JSON.stringify(signal))
                            break
                        }

                        case AppTopics.clients: {
                            console.log(`Received client list: ${data.payload.resource}`)
                            const clients = JSON.parse(data.payload.resource) as ClientData[];
                            clients.forEach(client => {
                                clientsRepository.setClientDataById(client.clientId, client)
                            })
                            break
                        }

                        case AppTopics.rooms: {
                            const roomDetails = JSON.parse(data.payload.resource) as RoomDetails;
                            roomsRepository.setRoomDataById(roomDetails.name, roomDetails)

                            console.log(`Received room details: ${JSON.stringify(roomDetails)}`)

                            if (
                                roomDetails.members.map(member => member === clientData.sessionId)
                            ) {
                                console.log(clientData.sessionId + ' is a member of the room. Connecting to peers: ' + roomDetails.members)

                                for (const member of roomDetails.members) {

                                    if(clientsRepository.findClientDataById(member) === undefined) {
                                        console.log(`Client ${member} not found in cache, skipping connection attempt`)
                                        continue
                                    }

                                    await webRtcQueueBox.connectToPeerIfAbsent(member)
                                }
                            }

                            break
                        }
                    }
                }
            }
        )
}
