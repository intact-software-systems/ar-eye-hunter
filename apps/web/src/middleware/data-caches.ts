import {ALMessage} from "@shared/al-contracts/al-contract.ts";
import {AppTopics, ClientData, RoomDetails} from "@shared/api/api-config.ts";
import {WsQueueBoxClientService} from "@shared/services/WsQueueBoxClientService.ts";
import {WebRtcQueueBoxClientService} from "@shared/services/WebRtcQueueBoxClientService.ts";
import {QRtcSignalingMessage} from "@shared/webrtc/QRtcSignalingContracts.ts";

export const chatMessageById = new Map<string, ALMessage>();
export const clientDataById = new Map<string, ClientData>();
export const roomDataById = new Map<string, RoomDetails>();

export function initialise(
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcQueueBox: WebRtcQueueBoxClientService,
    clientData: ClientData
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

                            if (peer.sessionId === clientData.sessionId) {
                                console.log('Received my own client data. Ignoring it: ' + JSON.stringify(peer));
                            } else {
                                console.log(`Connect to peer over RTC: ${JSON.stringify(peer)}`);
                                await webRtcQueueBox.connectToPeer(peer.sessionId)
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
