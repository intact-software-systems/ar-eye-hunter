import { ALMessage } from "@shared/al-contracts/al-contract.ts";
import { AppTopics, ClientData, RoomDetails } from "@shared/api/api-config.ts";
import { WebRtcQueueBoxClientService } from "@shared/services/WebRtcQueueBoxClientService.ts";
import { WsQueueBoxClientService } from "@shared/services/WsQueueBoxClientService.ts";
import { QRtcSignalingMessage } from "@shared/webrtc/QRtcSignalingContracts.ts";
import { listRooms } from "./api-integration.ts";
import { ChatMessage } from "../chat/chat-screen.ts";

// TODO: Add version and timestamps on every shared message type

export const cachedChatMessageById = new Map<string, ChatMessage>();
export const cachedClientDataById = new Map<string, ClientData>();
export const cachedRoomDataById = new Map<string, RoomDetails>();

// export const cachedRtcSignalingMessages = new Map<string, QRtcSignalingMessage>();

export async function initialise(
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcQueueBox: WebRtcQueueBoxClientService,
    clientData: ClientData
) {

    // TODO: Is it necessary to do this?
    try {
        (await listRooms())
            .forEach(room => {
                cachedRoomDataById.set(room.name, room)
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
                            const chatMessage = JSON.parse(data.payload.resource) as ChatMessage;
                            cachedChatMessageById.set(chatMessage.id, chatMessage)
                            break;
                        }

                        case AppTopics.client: {
                            const peer = JSON.parse(data.payload.resource) as ClientData;
                            cachedClientDataById.set(peer.clientId, peer)
                            break;
                        }

                        case AppTopics.rtcSignaling: {
                            const signal = JSON.parse(data.payload.resource) as QRtcSignalingMessage;
                            console.log('RTC signaling message :' + JSON.stringify(signal))
                            // cachedRtcSignalingMessages.set(data.key.resourceId, signal)
                            break
                        }

                        case AppTopics.rooms: {
                            const roomDetails = JSON.parse(data.payload.resource) as RoomDetails;
                            cachedRoomDataById.set(roomDetails.name, roomDetails)

                            console.log(`Received room details: ${JSON.stringify(roomDetails)}`)

                            if (
                                roomDetails.members.map(member => member === clientData.sessionId)
                            ) {
                                console.log(clientData.sessionId + ' is a member of the room. Connecting to peers: ' + roomDetails.members)

                                for (const member of roomDetails.members) {
                                    await webRtcQueueBox.connectToPeer(member)
                                }
                            }

                            break
                        }
                    }
                }
            }
        )
}
